/**
 * Local SQLite store — the ONLY place user data lives. No network, no
 * telemetry, no accounts. File: data/privacy-janitor.db (gitignored).
 *
 * Uses Node's built-in node:sqlite (Node 22.5+/24) so the project has zero
 * native-build dependencies — `npm install` just works on any OS.
 */
import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type {
  Identity,
  Listing,
  OptOutReceipt,
  PreparedOptOut,
  ScanRun,
  Submission,
  SubmissionStatus,
} from "@/types"

// PJ_DATA_DIR lets tests (scripts/smoke) point the store at a temp dir
// without touching the user's real database.
const DATA_DIR = process.env.PJ_DATA_DIR ?? join(process.cwd(), "data")
const DB_PATH = join(DATA_DIR, "privacy-janitor.db")

// Singleton across Next.js dev hot reloads.
const g = globalThis as unknown as { __pjDb?: DatabaseSync }

function open(): DatabaseSync {
  if (g.__pjDb) return g.__pjDb
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  migrate(db)
  g.__pjDb = db
  return db
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      city TEXT NOT NULL,
      state_code TEXT NOT NULL,
      age_range TEXT,
      relatives TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      broker_id TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      url TEXT NOT NULL,
      display_name TEXT NOT NULL,
      exposed_data TEXT NOT NULL DEFAULT '{}',
      screenshot_path TEXT,
      confirmed_mine INTEGER,
      raw_snippet TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submit_session_id TEXT,
      confirm_session_id TEXT,
      preview_screenshot_path TEXT,
      result_screenshot_path TEXT,
      removed_verified_at TEXT,
      last_error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      results TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS prepared_optouts (
      listing_id TEXT PRIMARY KEY,
      broker_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  // ── migrations for pre-existing databases ─────────────────────────────────
  // Additive columns only; wrapped in try/catch because ALTER TABLE throws
  // if the column already exists (node:sqlite has no IF NOT EXISTS).
  const migrations: Array<[string, string]> = [
    ["submissions", "ALTER TABLE submissions ADD COLUMN confirm_evidence_dir TEXT"],
  ]
  for (const [table, sql] of migrations) {
    try {
      db.exec(sql)
    } catch {
      // column already present
    }
  }
}

/** Close the singleton DB handle (tests/CLI exit cleanly on Windows). */
export function closeDb(): void {
  if (g.__pjDb) {
    g.__pjDb.close()
    g.__pjDb = undefined
  }
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

// ── identities ──────────────────────────────────────────────────────────────

export function saveIdentity(identity: Identity): void {
  open()
    .prepare(
      `INSERT INTO identities (id, full_name, city, state_code, age_range, relatives, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         full_name=excluded.full_name, city=excluded.city,
         state_code=excluded.state_code, age_range=excluded.age_range,
         relatives=excluded.relatives`,
    )
    .run(
      identity.id,
      identity.fullName,
      identity.city,
      identity.stateCode,
      identity.ageRange ?? null,
      identity.relatives ? JSON.stringify(identity.relatives) : null,
      identity.createdAt,
    )
}

export function getIdentity(id: string): Identity | undefined {
  const row = open().prepare("SELECT * FROM identities WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToIdentity(row) : undefined
}

export function listIdentities(): Identity[] {
  const rows = open().prepare("SELECT * FROM identities ORDER BY created_at DESC").all() as Array<
    Record<string, unknown>
  >
  return rows.map(rowToIdentity)
}

function rowToIdentity(r: Record<string, unknown>): Identity {
  return {
    id: r.id as string,
    fullName: r.full_name as string,
    city: r.city as string,
    stateCode: r.state_code as string,
    ageRange: (r.age_range as string) ?? undefined,
    relatives: r.relatives ? JSON.parse(r.relatives as string) : undefined,
    createdAt: r.created_at as string,
  }
}

/**
 * Transactional identity deletion. Removes the identity, its listings,
 * submissions, prepared opt-outs, and scan runs in ONE transaction — the
 * database never ends up half-deleted. Returns the evidence directories
 * (screenshot folders) the caller should remove from disk after the
 * transaction commits, keyed by listing id.
 */
export function deleteIdentity(identityId: string): string[] {
  const db = open()
  const evidenceDirs: string[] = []

  db.exec("BEGIN")
  try {
    const listings = db
      .prepare("SELECT id FROM listings WHERE identity_id = ?")
      .all(identityId) as Array<{ id: string }>

    for (const { id } of listings) {
      // collect evidence paths + prepared state before deleting rows
      const sub = db
        .prepare(
          "SELECT preview_screenshot_path, result_screenshot_path, confirm_evidence_dir FROM submissions WHERE listing_id = ?",
        )
        .get(id) as Record<string, unknown> | undefined
      if (sub) {
        for (const k of ["preview_screenshot_path", "result_screenshot_path", "confirm_evidence_dir"]) {
          const p = sub[k] as string | null
          if (p) evidenceDirs.push(p)
        }
      }
      const prepared = db
        .prepare("SELECT state FROM prepared_optouts WHERE listing_id = ?")
        .get(id) as { state?: string } | undefined
      if (prepared?.state) {
        try {
          const state = JSON.parse(prepared.state) as Record<string, string>
          if (state.previewPath) evidenceDirs.push(state.previewPath)
          if (state.sessionEvidenceDir) evidenceDirs.push(state.sessionEvidenceDir)
        } catch {
          /* malformed state — nothing to collect */
        }
      }
      db.prepare("DELETE FROM submissions WHERE listing_id = ?").run(id)
      db.prepare("DELETE FROM prepared_optouts WHERE listing_id = ?").run(id)
    }

    // listing-level evidence dirs (scan screenshots)
    const listingDirs = db
      .prepare("SELECT screenshot_path FROM listings WHERE identity_id = ?")
      .all(identityId) as Array<{ screenshot_path: string | null }>
    for (const row of listingDirs) {
      if (row.screenshot_path) evidenceDirs.push(row.screenshot_path)
    }

    db.prepare("DELETE FROM listings WHERE identity_id = ?").run(identityId)
    db.prepare("DELETE FROM scan_runs WHERE identity_id = ?").run(identityId)
    const res = db.prepare("DELETE FROM identities WHERE id = ?").run(identityId)
    if (res.changes === 0) throw new Error(`identity ${identityId} not found`)

    db.exec("COMMIT")
    return evidenceDirs
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

/**
 * Full factory reset: drop every identity, listing, submission, run, and
 * prepared opt-out in one transaction. Returns all evidence dirs + the DB
 * path itself (caller deletes data/ wholesale).
 */
export function resetAll(): { evidenceDirs: string[] } {
  const db = open()
  const evidenceDirs: string[] = []

  db.exec("BEGIN")
  try {
    const listings = db.prepare("SELECT id, screenshot_path FROM listings").all() as Array<{
      id: string
      screenshot_path: string | null
    }>
    for (const l of listings) {
      if (l.screenshot_path) evidenceDirs.push(l.screenshot_path)
      const sub = db
        .prepare(
          "SELECT preview_screenshot_path, result_screenshot_path, confirm_evidence_dir FROM submissions WHERE listing_id = ?",
        )
        .get(l.id) as Record<string, unknown> | undefined
      if (sub) {
        for (const k of ["preview_screenshot_path", "result_screenshot_path", "confirm_evidence_dir"]) {
          const p = sub[k] as string | null
          if (p) evidenceDirs.push(p)
        }
      }
      const prepared = db.prepare("SELECT state FROM prepared_optouts WHERE listing_id = ?").get(l.id) as
        | { state?: string }
        | undefined
      if (prepared?.state) {
        try {
          const state = JSON.parse(prepared.state) as Record<string, string>
          if (state.previewPath) evidenceDirs.push(state.previewPath)
          if (state.sessionEvidenceDir) evidenceDirs.push(state.sessionEvidenceDir)
        } catch {
          /* ignore */
        }
      }
    }

    db.exec("DELETE FROM submissions")
    db.exec("DELETE FROM prepared_optouts")
    db.exec("DELETE FROM listings")
    db.exec("DELETE FROM scan_runs")
    db.exec("DELETE FROM identities")
    db.exec("COMMIT")
    return { evidenceDirs }
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

// ── listings ────────────────────────────────────────────────────────────────

export function upsertListing(listing: Listing): void {
  open()
    .prepare(
      `INSERT INTO listings
         (id, broker_id, identity_id, url, display_name, exposed_data,
          screenshot_path, confirmed_mine, raw_snippet, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         url=excluded.url, display_name=excluded.display_name,
         exposed_data=excluded.exposed_data, screenshot_path=excluded.screenshot_path,
         confirmed_mine=excluded.confirmed_mine, last_seen_at=excluded.last_seen_at`,
    )
    .run(
      listing.id,
      listing.brokerId,
      listing.identityId,
      listing.url,
      listing.displayName,
      JSON.stringify(listing.exposedData),
      listing.screenshotPath ?? null,
      listing.confirmedMine === null ? null : listing.confirmedMine ? 1 : 0,
      listing.rawSnippet ?? null,
      listing.firstSeenAt,
      listing.lastSeenAt,
    )
}

export function getListing(id: string): Listing | undefined {
  const row = open().prepare("SELECT * FROM listings WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | undefined
  return row ? rowToListing(row) : undefined
}

export function listListings(identityId?: string): Listing[] {
  const db = open()
  const rows = (
    identityId
      ? db
          .prepare("SELECT * FROM listings WHERE identity_id = ? ORDER BY first_seen_at DESC")
          .all(identityId)
      : db.prepare("SELECT * FROM listings ORDER BY first_seen_at DESC").all()
  ) as Array<Record<string, unknown>>
  return rows.map(rowToListing)
}

function rowToListing(r: Record<string, unknown>): Listing {
  const confirmed = r.confirmed_mine as number | null
  return {
    id: r.id as string,
    brokerId: r.broker_id as string,
    identityId: r.identity_id as string,
    url: r.url as string,
    displayName: r.display_name as string,
    exposedData: JSON.parse(r.exposed_data as string),
    screenshotPath: (r.screenshot_path as string) ?? undefined,
    confirmedMine: confirmed === null ? null : confirmed === 1,
    rawSnippet: (r.raw_snippet as string) ?? undefined,
    firstSeenAt: r.first_seen_at as string,
    lastSeenAt: r.last_seen_at as string,
  }
}

export function setListingConfirmed(id: string, confirmed: boolean): void {
  open().prepare("UPDATE listings SET confirmed_mine = ? WHERE id = ?").run(confirmed ? 1 : 0, id)
}

/** Drop a listing (and its submissions/prepared state) entirely. */
export function deleteListing(id: string): void {
  const db = open()
  db.prepare("DELETE FROM submissions WHERE listing_id = ?").run(id)
  db.prepare("DELETE FROM prepared_optouts WHERE listing_id = ?").run(id)
  db.prepare("DELETE FROM listings WHERE id = ?").run(id)
}

// ── submissions ─────────────────────────────────────────────────────────────

export function createSubmission(listingId: string): Submission {
  const now = new Date().toISOString()
  const sub: Submission = {
    id: newId("sub"),
    listingId,
    status: "prepared",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  }
  open()
    .prepare(
      `INSERT INTO submissions
         (id, listing_id, status, created_at, updated_at, attempts)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(sub.id, sub.listingId, sub.status, sub.createdAt, sub.updatedAt)
  return sub
}

export function updateSubmission(
  id: string,
  patch: Partial<Pick<Submission, "status">> & {
    submitSessionId?: string
    confirmSessionId?: string
    confirmEvidenceDir?: string
    previewScreenshotPath?: string
    resultScreenshotPath?: string
    removedVerifiedAt?: string
    lastError?: string
    incrementAttempts?: boolean
  },
): void {
  const cur = open().prepare("SELECT * FROM submissions WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | undefined
  if (!cur) throw new Error(`submission ${id} not found`)
  const status = (patch.status ?? cur.status) as SubmissionStatus
  open()
    .prepare(
      `UPDATE submissions SET
         status = ?, updated_at = ?,
         submit_session_id = ?,
         confirm_session_id = ?,
         confirm_evidence_dir = ?,
         preview_screenshot_path = ?,
         result_screenshot_path = ?,
         removed_verified_at = ?,
         last_error = ?,
         attempts = attempts + ?
       WHERE id = ?`,
    )
    .run(
      status,
      new Date().toISOString(),
      patch.submitSessionId ?? (cur.submit_session_id as string | null) ?? null,
      patch.confirmSessionId ?? (cur.confirm_session_id as string | null) ?? null,
      patch.confirmEvidenceDir ?? (cur.confirm_evidence_dir as string | null) ?? null,
      patch.previewScreenshotPath ?? (cur.preview_screenshot_path as string | null) ?? null,
      patch.resultScreenshotPath ?? (cur.result_screenshot_path as string | null) ?? null,
      patch.removedVerifiedAt ?? (cur.removed_verified_at as string | null) ?? null,
      patch.lastError ?? (cur.last_error as string | null) ?? null,
      patch.incrementAttempts ? 1 : 0,
      id,
    )
}

export function listSubmissions(listingId?: string): Submission[] {
  const db = open()
  const rows = (
    listingId
      ? db.prepare("SELECT * FROM submissions WHERE listing_id = ? ORDER BY created_at DESC").all(listingId)
      : db.prepare("SELECT * FROM submissions ORDER BY created_at DESC").all()
  ) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as string,
    listingId: r.listing_id as string,
    status: r.status as SubmissionStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    submitSessionId: (r.submit_session_id as string) ?? undefined,
    confirmSessionId: (r.confirm_session_id as string) ?? undefined,
    previewScreenshotPath: (r.preview_screenshot_path as string) ?? undefined,
    resultScreenshotPath: (r.result_screenshot_path as string) ?? undefined,
    removedVerifiedAt: (r.removed_verified_at as string) ?? undefined,
    lastError: (r.last_error as string) ?? undefined,
    attempts: r.attempts as number,
  }))
}

// ── scan runs ───────────────────────────────────────────────────────────────

export function createScanRun(identityId: string): ScanRun {
  const run: ScanRun = {
    id: newId("scan"),
    identityId,
    startedAt: new Date().toISOString(),
    results: [],
  }
  open()
    .prepare("INSERT INTO scan_runs (id, identity_id, started_at, results) VALUES (?, ?, ?, '[]')")
    .run(run.id, run.identityId, run.startedAt)
  return run
}

export function finishScanRun(run: ScanRun): void {
  open()
    .prepare("UPDATE scan_runs SET finished_at = ?, results = ? WHERE id = ?")
    .run(new Date().toISOString(), JSON.stringify(run.results), run.id)
}

export function listScanRuns(identityId?: string): ScanRun[] {
  const db = open()
  const rows = (
    identityId
      ? db.prepare("SELECT * FROM scan_runs WHERE identity_id = ? ORDER BY started_at DESC").all(identityId)
      : db.prepare("SELECT * FROM scan_runs ORDER BY started_at DESC").all()
  ) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as string,
    identityId: r.identity_id as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? undefined,
    results: JSON.parse(r.results as string),
  }))
}

// ── prepared opt-outs (between prepare and user approval) ──────────────────

export function savePreparedOptOut(prepared: PreparedOptOut): void {
  open()
    .prepare(
      `INSERT INTO prepared_optouts (listing_id, broker_id, state, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(listing_id) DO UPDATE SET
         state=excluded.state, created_at=excluded.created_at`,
    )
    .run(prepared.listingId, prepared.brokerId, JSON.stringify(prepared.state), prepared.createdAt)
}

export function getPreparedOptOut(listingId: string): PreparedOptOut | undefined {
  const row = open()
    .prepare("SELECT * FROM prepared_optouts WHERE listing_id = ?")
    .get(listingId) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    listingId: row.listing_id as string,
    brokerId: row.broker_id as string,
    state: JSON.parse(row.state as string),
    createdAt: row.created_at as string,
  }
}

export function deletePreparedOptOut(listingId: string): void {
  open().prepare("DELETE FROM prepared_optouts WHERE listing_id = ?").run(listingId)
}

/** Receipts are derived data; kept in submissions only. This type re-export
 *  keeps the module's public surface explicit. */
export type { OptOutReceipt }
