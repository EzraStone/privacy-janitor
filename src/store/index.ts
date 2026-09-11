/**
 * Local SQLite persistence. Screenshots also live on disk; the separate
 * browser/scoring engines send data to providers. This module has no network.
 * File: data/privacy-janitor.db (gitignored).
 *
 * Uses Node's built-in node:sqlite (Node 22.5+/24) so the project has zero
 * native-build dependencies — `npm install` just works on any OS.
 */
import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { getDatabasePath } from "../config/paths.ts"
import { activeSubmissionStatuses, canTransition } from "../engine/submission-state.ts"
import type {
  BrokerScanObservation,
  Identity,
  Listing,
  OptOutReceipt,
  PreparedOptOut,
  ScanBrokerResult,
  ScanKind,
  ScanListingEvent,
  ScanRun,
  Submission,
  SubmissionOperation,
  SubmissionStatus,
} from "@/types"

// PJ_DATA_DIR lets tests and demos use an isolated store without touching
// the user's real database or evidence directory.
const DB_PATH = getDatabasePath()

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
      last_seen_at TEXT NOT NULL,
      presence_status TEXT NOT NULL DEFAULT 'seen',
      last_checked_at TEXT,
      last_absent_at TEXT
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
      confirm_evidence_dir TEXT,
      removed_verified_at TEXT,
      last_error TEXT,
      attention_operation TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      results TEXT NOT NULL DEFAULT '[]',
      kind TEXT NOT NULL DEFAULT 'scan',
      events TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS prepared_optouts (
      listing_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      broker_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  // ── migrations for pre-existing databases ─────────────────────────────────
  // Inspect the schema first so only "already exists" is ignored. Any real
  // migration failure aborts startup with its original SQLite error.
  db.exec("BEGIN")
  try {
    const legacySubmissionModel = !(db.prepare("PRAGMA table_info(submissions)").all() as Array<{ name: string }> )
      .some((column) => column.name === "attention_operation")
    ensureColumn(db, "submissions", "confirm_evidence_dir", "TEXT")
    ensureColumn(db, "submissions", "attention_operation", "TEXT")
    ensureColumn(db, "prepared_optouts", "submission_id", "TEXT")
    ensureColumn(db, "listings", "presence_status", "TEXT NOT NULL DEFAULT 'seen'")
    ensureColumn(db, "listings", "last_checked_at", "TEXT")
    ensureColumn(db, "listings", "last_absent_at", "TEXT")
    ensureColumn(db, "scan_runs", "kind", "TEXT NOT NULL DEFAULT 'scan'")
    ensureColumn(db, "scan_runs", "events", "TEXT NOT NULL DEFAULT '[]'")

    // Older builds could leave more than one unfinished row. Close all but
    // the newest before enforcing the single-active-run invariant.
    const unfinished = db
      .prepare(
        "SELECT id, identity_id FROM scan_runs WHERE finished_at IS NULL ORDER BY started_at DESC",
      )
      .all() as Array<{ id: string; identity_id: string }>
    const newestByIdentity = new Set<string>()
    const migratedAt = new Date().toISOString()
    if (legacySubmissionModel) {
      db.prepare(`UPDATE submissions SET status = 'attention_required', attention_operation = 'submit',
        last_error = 'The previous app version may already have sent this request.', updated_at = ?
        WHERE status = 'approved'`).run(migratedAt)
    }
    for (const run of unfinished) {
      if (newestByIdentity.has(run.identity_id)) {
        db.prepare("UPDATE scan_runs SET finished_at = ? WHERE id = ?").run(migratedAt, run.id)
      } else {
        newestByIdentity.add(run.identity_id)
      }
    }

    // A process restart makes an in-flight remote click ambiguous. Never
    // retry it automatically: require the user to acknowledge that the
    // broker may already have received the action.
    db.prepare(
      `UPDATE submissions
       SET status = 'attention_required', attention_operation = 'submit',
           last_error = COALESCE(last_error, ?), updated_at = ?
       WHERE status = 'submitting'`,
    ).run("The app stopped while submission may have been in flight.", migratedAt)
    db.prepare(
      `UPDATE submissions
       SET status = 'attention_required', attention_operation = 'confirm',
           last_error = COALESCE(last_error, ?), updated_at = ?
       WHERE status = 'confirming'`,
    ).run("The app stopped while confirmation may have been in flight.", migratedAt)

    // Link legacy prepared browser state to its most relevant submission.
    db.exec(`
      UPDATE prepared_optouts
      SET submission_id = (
        SELECT id FROM submissions
        WHERE submissions.listing_id = prepared_optouts.listing_id
        ORDER BY
          CASE status
            WHEN 'confirmed' THEN 90
            WHEN 'awaiting_email' THEN 80
            WHEN 'submitted' THEN 80
            WHEN 'attention_required' THEN 70
            WHEN 'approved' THEN 60
            WHEN 'prepared' THEN 50
            WHEN 'failed' THEN 40
            ELSE 0
          END DESC,
          created_at DESC
        LIMIT 1
      )
      WHERE submission_id IS NULL OR submission_id = '';

      UPDATE submissions
      SET status = 'attention_required', attention_operation = 'submit',
          last_error = COALESCE(last_error,
            'A legacy submission failure may have happened after the broker received it.'),
          updated_at = '${migratedAt}'
      WHERE status = 'failed' AND ${legacySubmissionModel ? "1" : "0"}
        AND id IN (SELECT submission_id FROM prepared_optouts);

      UPDATE submissions
      SET status = 'cancelled',
          last_error = COALESCE(last_error, 'Prepared browser state was not recoverable.'),
          updated_at = '${migratedAt}'
      WHERE status = 'prepared'
        AND NOT EXISTS (
          SELECT 1 FROM prepared_optouts
          WHERE prepared_optouts.submission_id = submissions.id
        );
    `)

    // Older endpoints could create multiple live attempts. Keep the most
    // advanced attempt and make the rest terminal before adding uniqueness.
    const activeSubmissions = db
      .prepare(
        `SELECT id, listing_id FROM submissions
         WHERE status IN (
           'prepared', 'approved', 'submitting', 'submitted', 'awaiting_email',
           'confirming', 'confirmed', 'attention_required'
         )
         ORDER BY
           CASE status
             WHEN 'confirmed' THEN 90
             WHEN 'awaiting_email' THEN 80
             WHEN 'submitted' THEN 80
             WHEN 'attention_required' THEN 70
             WHEN 'approved' THEN 60
             WHEN 'prepared' THEN 50
             ELSE 40
           END DESC,
           created_at DESC`,
      )
      .all() as Array<{ id: string; listing_id: string }>
    const keptListings = new Set<string>()
    for (const submission of activeSubmissions) {
      if (keptListings.has(submission.listing_id)) {
        db.prepare(
          `UPDATE submissions
           SET status = 'cancelled', attention_operation = NULL,
               last_error = COALESCE(last_error, 'Superseded by another active attempt.'),
               updated_at = ?
           WHERE id = ?`,
        ).run(migratedAt, submission.id)
      } else {
        keptListings.add(submission.listing_id)
      }
    }

    db.exec(`
      DELETE FROM prepared_optouts
      WHERE NOT EXISTS (
        SELECT 1 FROM submissions
        WHERE submissions.id = prepared_optouts.submission_id
          AND submissions.listing_id = prepared_optouts.listing_id
          AND (
            submissions.status IN ('prepared', 'approved')
            OR (
              submissions.status = 'attention_required'
              AND submissions.attention_operation = 'submit'
            )
          )
      );
    `)

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_listings_identity_broker
        ON listings(identity_id, broker_id);
      CREATE INDEX IF NOT EXISTS idx_submissions_listing_created
        ON submissions(listing_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_runs_one_unfinished_identity
        ON scan_runs(identity_id) WHERE finished_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_one_active_listing
        ON submissions(listing_id)
        WHERE status IN (
          'prepared', 'approved', 'submitting', 'submitted', 'awaiting_email',
          'confirming', 'confirmed', 'attention_required'
        );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prepared_optouts_submission
        ON prepared_optouts(submission_id) WHERE submission_id IS NOT NULL;
    `)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((candidate) => candidate.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
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
      const submissions = db
        .prepare(
          "SELECT preview_screenshot_path, result_screenshot_path, confirm_evidence_dir FROM submissions WHERE listing_id = ?",
        )
        .all(id) as Array<Record<string, unknown>>
      for (const sub of submissions) {
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
    collectScanEvidence(
      db.prepare("SELECT results FROM scan_runs WHERE identity_id = ?").all(identityId) as Array<{
        results: string
      }>,
      evidenceDirs,
    )

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
      const submissions = db
        .prepare(
          "SELECT preview_screenshot_path, result_screenshot_path, confirm_evidence_dir FROM submissions WHERE listing_id = ?",
        )
        .all(l.id) as Array<Record<string, unknown>>
      for (const sub of submissions) {
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
    collectScanEvidence(
      db.prepare("SELECT results FROM scan_runs").all() as Array<{ results: string }>,
      evidenceDirs,
    )

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

function collectScanEvidence(rows: Array<{ results: string }>, target: string[]): void {
  for (const row of rows) {
    try {
      const results = JSON.parse(row.results) as Array<{ evidenceDir?: unknown }>
      for (const result of results) {
        if (typeof result.evidenceDir === "string" && !target.includes(result.evidenceDir)) {
          target.push(result.evidenceDir)
        }
      }
    } catch {
      /* legacy/corrupt result JSON has no recoverable evidence path */
    }
  }
}

// ── listings ────────────────────────────────────────────────────────────────

export function upsertListing(listing: Listing): void {
  open()
    .prepare(
      `INSERT INTO listings
         (id, broker_id, identity_id, url, display_name, exposed_data,
          screenshot_path, confirmed_mine, raw_snippet, first_seen_at, last_seen_at,
          presence_status, last_checked_at, last_absent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         url=excluded.url, display_name=excluded.display_name,
         exposed_data=excluded.exposed_data, screenshot_path=excluded.screenshot_path,
         confirmed_mine=excluded.confirmed_mine, last_seen_at=excluded.last_seen_at,
         presence_status=excluded.presence_status,
         last_checked_at=excluded.last_checked_at,
         last_absent_at=COALESCE(excluded.last_absent_at, listings.last_absent_at)`,
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
      listing.presenceStatus ?? "seen",
      listing.lastCheckedAt ?? null,
      listing.lastAbsentAt ?? null,
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
    presenceStatus: ((r.presence_status as string) || "seen") as Listing["presenceStatus"],
    lastCheckedAt: (r.last_checked_at as string) ?? undefined,
    lastAbsentAt: (r.last_absent_at as string) ?? undefined,
  }
}

function canonicalListingUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const pathname = url.pathname.replace(/\/+$/, "") || "/"
    url.searchParams.sort()
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch {
    return raw.trim().toLowerCase()
  }
}

/**
 * Atomically apply one broker observation. Inconclusive scans may add records
 * that were positively seen, but they can never mark an older record absent.
 */
export function recordBrokerScanObservation(input: {
  identityId: string
  brokerId: string
  runKind: ScanKind
  observation: BrokerScanObservation
  evidenceDir: string
  /** When supplied together, broker state + run checkpoint commit atomically. */
  runId?: string
  result?: ScanBrokerResult
}): ScanListingEvent[] {
  if (Boolean(input.runId) !== Boolean(input.result)) {
    throw new Error("runId and result must be supplied together")
  }
  const db = open()
  const now = new Date().toISOString()
  const events: ScanListingEvent[] = []

  db.exec("BEGIN IMMEDIATE")
  try {
    let checkpoint:
      | { results: ScanBrokerResult[]; events: ScanListingEvent[] }
      | undefined
    if (input.runId && input.result) {
      const row = db
        .prepare(
          "SELECT identity_id, finished_at, results, kind, events FROM scan_runs WHERE id = ?",
        )
        .get(input.runId) as
        | {
            identity_id: string
            finished_at: string | null
            results: string
            kind: ScanKind
            events: string
          }
        | undefined
      if (!row || row.finished_at) throw new Error(`active scan ${input.runId} not found`)
      if (row.identity_id !== input.identityId || row.kind !== input.runKind) {
        throw new Error(`scan ${input.runId} does not match this broker observation`)
      }
      if (input.result.brokerId !== input.brokerId) {
        throw new Error("broker result does not match the observation")
      }
      if (
        input.result.outcome !== input.observation.outcome ||
        input.result.listingsFound !== input.observation.listings.length
      ) {
        throw new Error("broker checkpoint does not match the observed outcome")
      }
      const results = JSON.parse(row.results) as ScanBrokerResult[]
      if (results.some((result) => result.brokerId === input.brokerId)) {
        throw new Error(`${input.brokerId} is already checkpointed for scan ${input.runId}`)
      }
      checkpoint = {
        results,
        events: JSON.parse(row.events) as ScanListingEvent[],
      }
    }

    const existing = (
      db
        .prepare("SELECT * FROM listings WHERE identity_id = ? AND broker_id = ?")
        .all(input.identityId, input.brokerId) as Array<Record<string, unknown>>
    ).map(rowToListing)
    const byUrl = new Map(existing.map((listing) => [canonicalListingUrl(listing.url), listing]))
    const freshKeys = new Set<string>()

    for (const incoming of input.observation.listings) {
      const key = canonicalListingUrl(incoming.url)
      if (freshKeys.has(key)) continue
      freshKeys.add(key)
      const prior = byUrl.get(key)
      const listing: Listing = {
        ...incoming,
        id: prior?.id ?? incoming.id,
        confirmedMine: prior?.confirmedMine ?? incoming.confirmedMine,
        firstSeenAt: prior?.firstSeenAt ?? incoming.firstSeenAt,
        lastSeenAt: now,
        screenshotPath: input.evidenceDir,
        presenceStatus: "seen",
        lastCheckedAt: now,
        lastAbsentAt: prior?.lastAbsentAt,
      }
      upsertListing(listing)

      if (input.runKind === "rescan") {
        events.push({
          listingId: listing.id,
          brokerId: input.brokerId,
          type: prior?.presenceStatus === "absent"
            ? "relisted"
            : prior
              ? "still_listed"
              : "new",
          recordedAt: now,
        })
      }
    }

    // A positive result proves only what was seen; it does not prove every
    // older, unreturned result is gone (ranking, infinite scroll, and query
    // drift can all hide candidates). Broker-wide absence requires the
    // adapter's explicit, non-paginated zero-results state.
    if (input.runKind === "rescan" && input.observation.outcome === "clear") {
      for (const prior of existing) {
        if (freshKeys.has(canonicalListingUrl(prior.url))) continue

        db.prepare(
          `UPDATE listings
           SET presence_status = 'absent', last_checked_at = ?, last_absent_at = ?
           WHERE id = ?`,
        ).run(now, now, prior.id)

        const submission = db
          .prepare(
            `SELECT id, status FROM submissions
             WHERE listing_id = ? AND status IN ('submitted', 'confirmed', 'removed')
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(prior.id) as { id: string; status: SubmissionStatus } | undefined
        const removalWasActioned = Boolean(submission)

        let type: ScanListingEvent["type"]
        if (prior.presenceStatus === "absent") {
          type = removalWasActioned ? "still_removed" : "no_longer_seen"
        } else if (removalWasActioned) {
          type = "removed"
          if (submission && submission.status !== "removed") {
            db.prepare(
              `UPDATE submissions
               SET status = 'removed', updated_at = ?,
                   removed_verified_at = COALESCE(removed_verified_at, ?)
               WHERE id = ?`,
            ).run(now, now, submission.id)
          }
        } else {
          type = "no_longer_seen"
        }

        events.push({ listingId: prior.id, brokerId: input.brokerId, type, recordedAt: now })
      }
    }

    if (checkpoint && input.runId && input.result) {
      checkpoint.results.push(input.result)
      checkpoint.events.push(...events)
      const saved = db
        .prepare(
          "UPDATE scan_runs SET results = ?, events = ? WHERE id = ? AND finished_at IS NULL",
        )
        .run(JSON.stringify(checkpoint.results), JSON.stringify(checkpoint.events), input.runId)
      if (saved.changes !== 1) throw new Error(`scan ${input.runId} could not be checkpointed`)
    }

    db.exec("COMMIT")
    return events
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
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
    lastError?: string | null
    attentionOperation?: SubmissionOperation | null
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
         attention_operation = ?,
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
      patch.lastError === undefined ? (cur.last_error as string | null) ?? null : patch.lastError,
      patch.attentionOperation === undefined
        ? (cur.attention_operation as string | null) ?? null : patch.attentionOperation,
      patch.incrementAttempts ? 1 : 0,
      id,
    )
}

export function listSubmissions(listingId?: string): Submission[] {
  const db = open()
  const rows = (
    listingId
      ? db.prepare("SELECT * FROM submissions WHERE listing_id = ? ORDER BY created_at DESC, rowid DESC").all(listingId)
      : db.prepare("SELECT * FROM submissions ORDER BY created_at DESC, rowid DESC").all()
  ) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as string,
    listingId: r.listing_id as string,
    status: r.status as SubmissionStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    submitSessionId: (r.submit_session_id as string) ?? undefined,
    confirmSessionId: (r.confirm_session_id as string) ?? undefined,
    confirmEvidenceDir: (r.confirm_evidence_dir as string) ?? undefined,
    previewScreenshotPath: (r.preview_screenshot_path as string) ?? undefined,
    resultScreenshotPath: (r.result_screenshot_path as string) ?? undefined,
    removedVerifiedAt: (r.removed_verified_at as string) ?? undefined,
    lastError: (r.last_error as string) ?? undefined,
    attentionOperation: (r.attention_operation as SubmissionOperation) ?? undefined,
    attempts: r.attempts as number,
  }))
}

// ── scan runs ───────────────────────────────────────────────────────────────

export function createScanRun(identityId: string, kind: ScanKind = "scan"): ScanRun {
  const run: ScanRun = {
    id: newId("scan"),
    identityId,
    kind,
    startedAt: new Date().toISOString(),
    results: [],
    events: [],
  }
  open()
    .prepare(
      "INSERT INTO scan_runs (id, identity_id, started_at, results, kind, events) VALUES (?, ?, ?, '[]', ?, '[]')",
    )
    .run(run.id, run.identityId, run.startedAt, run.kind)
  return run
}

export function getScanRun(id: string): ScanRun | undefined {
  const row = open().prepare("SELECT * FROM scan_runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToScanRun(row) : undefined
}

/** Persist broker-by-broker progress so an interrupted scan can resume. */
export function saveScanRunProgress(run: ScanRun): boolean {
  const result = open()
    .prepare("UPDATE scan_runs SET results = ?, events = ? WHERE id = ?")
    .run(JSON.stringify(run.results), JSON.stringify(run.events), run.id)
  return result.changes > 0
}

export function finishScanRun(run: ScanRun): void {
  run.finishedAt = new Date().toISOString()
  open()
    .prepare("UPDATE scan_runs SET finished_at = ?, results = ?, events = ? WHERE id = ?")
    .run(run.finishedAt, JSON.stringify(run.results), JSON.stringify(run.events), run.id)
}

export function listScanRuns(identityId?: string): ScanRun[] {
  const db = open()
  const rows = (
    identityId
      ? db.prepare("SELECT * FROM scan_runs WHERE identity_id = ? ORDER BY started_at DESC").all(identityId)
      : db.prepare("SELECT * FROM scan_runs ORDER BY started_at DESC").all()
  ) as Array<Record<string, unknown>>
  return rows.map(rowToScanRun)
}

function rowToScanRun(r: Record<string, unknown>): ScanRun {
  const rawResults = JSON.parse(r.results as string) as Array<Record<string, unknown>>
  return {
    id: r.id as string,
    identityId: r.identity_id as string,
    kind: ((r.kind as string) || "scan") as ScanKind,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? undefined,
    results: rawResults.map((result) => {
      const outcome = (result.outcome as string | undefined) ??
        (result.ok && Number(result.listingsFound) > 0 ? "found" : "inconclusive")
      return {
        brokerId: result.brokerId as string,
        ok: outcome !== "inconclusive",
        outcome: outcome as ScanRun["results"][number]["outcome"],
        listingsFound: Number(result.listingsFound) || 0,
        issueCode: result.issueCode as ScanRun["results"][number]["issueCode"],
        error: result.error as string | undefined,
        evidenceDir: result.evidenceDir as string | undefined,
      }
    }),
    events: r.events ? JSON.parse(r.events as string) : [],
  }
}

// ── prepared opt-outs (between prepare and user approval) ──────────────────

export function savePreparedOptOut(prepared: PreparedOptOut): void {
  open()
    .prepare(
      `INSERT INTO prepared_optouts (listing_id, submission_id, broker_id, state, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(listing_id) DO UPDATE SET
         submission_id=excluded.submission_id, state=excluded.state, created_at=excluded.created_at`,
    )
    .run(prepared.listingId, prepared.submissionId, prepared.brokerId, JSON.stringify(prepared.state), prepared.createdAt)
}

export function getPreparedOptOut(listingId: string): PreparedOptOut | undefined {
  const row = open()
    .prepare("SELECT * FROM prepared_optouts WHERE listing_id = ?")
    .get(listingId) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    submissionId: row.submission_id as string,
    listingId: row.listing_id as string,
    brokerId: row.broker_id as string,
    state: JSON.parse(row.state as string),
    createdAt: row.created_at as string,
  }
}

export function deletePreparedOptOut(listingId: string, submissionId: string): void {
  open().prepare("DELETE FROM prepared_optouts WHERE listing_id = ? AND submission_id = ?")
    .run(listingId, submissionId)
}

export function getSubmission(id: string): Submission | undefined {
  const row = open().prepare("SELECT listing_id FROM submissions WHERE id = ?").get(id) as
    { listing_id: string } | undefined
  return row ? listSubmissions(row.listing_id).find((sub) => sub.id === id) : undefined
}

export function activeSubmission(listingId: string): Submission | undefined {
  return listSubmissions(listingId).find((sub) => activeSubmissionStatuses.includes(sub.status))
}

export function requireActionableListing(listingId: string): Listing {
  const listing = getListing(listingId)
  if (!listing) throw new Error("listing not found")
  if (listing.confirmedMine !== true) throw new Error("confirm that this listing is yours first")
  if (listing.presenceStatus === "absent") throw new Error("this listing is currently absent; rescan before another broker action")
  if (!getIdentity(listing.identityId)) throw new Error("profile not found")
  return listing
}

/** One transaction binds the preview and exact attempt; no half-prepared row. */
export function commitPreparedOptOut(input: Omit<PreparedOptOut, "submissionId">): Submission {
  const db = open()
  db.exec("BEGIN IMMEDIATE")
  try {
    requireActionableListing(input.listingId)
    const existing = activeSubmission(input.listingId)
    if (existing) {
      db.exec("COMMIT")
      return existing
    }
    const submission = createSubmission(input.listingId)
    savePreparedOptOut({ ...input, submissionId: submission.id })
    updateSubmission(submission.id, { previewScreenshotPath: input.state.previewPath })
    db.exec("COMMIT")
    return getSubmission(submission.id)!
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

/** Atomic compare-and-set: only the worker that claims the expected state acts. */
export function transitionSubmission(
  id: string,
  expected: SubmissionStatus,
  next: SubmissionStatus,
  patch: Omit<Parameters<typeof updateSubmission>[1], "status"> = {},
  deletePrepared = false,
): boolean {
  if (!canTransition(expected, next)) throw new Error(`invalid submission transition ${expected} -> ${next}`)
  const db = open()
  db.exec("BEGIN IMMEDIATE")
  try {
    const current = getSubmission(id)
    if (!current || current.status !== expected) {
      db.exec("COMMIT")
      return false
    }
    if (["approved", "submitting", "confirming"].includes(next)) {
      requireActionableListing(current.listingId)
    }
    updateSubmission(id, { ...patch, status: next })
    if (deletePrepared) deletePreparedOptOut(current.listingId, id)
    db.exec("COMMIT")
    return true
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function requireCurrentSubmission(listingId: string, submissionId: string): Submission {
  const sub = getSubmission(submissionId)
  if (!sub || sub.listingId !== listingId) throw new Error("submission does not belong to this listing")
  const current = activeSubmission(listingId) ?? listSubmissions(listingId)[0]
  if (current?.id !== sub.id) throw new Error("this attempt was superseded; refresh the queue")
  return sub
}

export function cancelSubmission(listingId: string, submissionId: string): Submission {
  const sub = requireCurrentSubmission(listingId, submissionId)
  if (sub.status === "cancelled") return sub
  if (!["prepared", "approved", "attention_required"].includes(sub.status)) {
    throw new Error("this attempt cannot be cancelled while a broker action is in flight or completed")
  }
  transitionSubmission(sub.id, sub.status, "cancelled", {}, true)
  return getSubmission(sub.id)!
}

/** Receipts are derived data; kept in submissions only. This type re-export
 *  keeps the module's public surface explicit. */
export type { OptOutReceipt }
