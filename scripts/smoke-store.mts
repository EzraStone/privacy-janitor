/**
 * Store transaction tests — exercises delete-identity / reset-all against a
 * THROWAWAY temp database (PJ_DATA_DIR), never the user's real data.
 *
 * Run: node --experimental-strip-types scripts/smoke-store.mts
 */
import "dotenv/config"
import { existsSync, mkdtempSync, rmSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const tempRoot = mkdtempSync(join(tmpdir(), "pj-smoke-"))
process.env.PJ_DATA_DIR = tempRoot

// Start with the pre-rescan schema so this suite also proves the additive
// migration works for existing users rather than only for fresh databases.
const legacyDb = new DatabaseSync(join(tempRoot, "privacy-janitor.db"))
legacyDb.exec(`
  CREATE TABLE listings (
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
  CREATE TABLE scan_runs (
    id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    results TEXT NOT NULL DEFAULT '[]'
  );
  INSERT INTO scan_runs (id, identity_id, started_at, results)
    VALUES ('scan_legacy_old', 'id_legacy', '2025-01-01T00:00:00.000Z', '[]');
  INSERT INTO scan_runs (id, identity_id, started_at, results)
    VALUES ('scan_legacy_new', 'id_legacy', '2025-01-02T00:00:00.000Z', '[]');
`)
legacyDb.close()

// Import AFTER setting PJ_DATA_DIR — module reads it at load time.
const store = await import("../src/store/index.ts")
const paths = await import("../src/config/paths.ts")

let failures = 0
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok    ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}`)
  }
}

console.log("smoke: identity CRUD")
check("store uses isolated data directory", paths.getDataDir() === tempRoot)
check(
  "legacy duplicate scans migrate to one unfinished run",
  store.listScanRuns("id_legacy").filter((run) => !run.finishedAt).length === 1,
)
check(
  "evidence uses the same isolated data directory",
  paths.getEvidenceDir() === join(tempRoot, "evidence"),
)
const id1 = {
  id: "id_smoke1",
  fullName: "Alice Doe",
  city: "Seattle",
  stateCode: "WA",
  createdAt: new Date().toISOString(),
}
const id2 = {
  id: "id_smoke2",
  fullName: "Bob Roe",
  city: "Austin",
  stateCode: "TX",
  createdAt: new Date().toISOString(),
}
store.saveIdentity(id1)
store.saveIdentity(id2)
check("save + list roundtrip", store.listIdentities().length === 2)
check("get by id", store.getIdentity("id_smoke1")?.fullName === "Alice Doe")

console.log("smoke: local data is owner-only")
// This suite's database was created by an older schema with default,
// world-readable permissions; opening it must tighten that.
if (process.platform !== "win32") {
  check("an existing world-readable database is tightened on open",
    (statSync(join(tempRoot, "privacy-janitor.db")).mode & 0o077) === 0)
}

console.log("smoke: listings + submissions scoping")
store.upsertListing({
  id: "lst_s1",
  brokerId: "whitepages",
  identityId: "id_smoke1",
  url: "https://example.com/a",
  displayName: "Alice Doe",
  exposedData: {},
  confirmedMine: true,
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
})
store.upsertListing({
  id: "lst_s2",
  brokerId: "spokeo",
  identityId: "id_smoke2",
  url: "https://example.com/b",
  displayName: "Bob Roe",
  exposedData: {},
  confirmedMine: null,
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
})
const sub = store.createSubmission("lst_s1")
store.updateSubmission(sub.id, { status: "awaiting_email" })
check("listings saved", store.listListings().length === 2)
check("submissions saved", store.listSubmissions("lst_s1").length === 1)

const preparedProxySessionId = "optout-whitepages-test"
store.savePreparedOptOut({
  submissionId: sub.id,
  listingId: "lst_s1",
  brokerId: "whitepages",
  state: { contactEmail: "test@example.com", proxySessionId: preparedProxySessionId },
  createdAt: new Date().toISOString(),
})
check(
  "prepared opt-out retains its sticky proxy session",
  store.getPreparedOptOut("lst_s1")?.state.proxySessionId === preparedProxySessionId,
)

console.log("smoke: listing decisions can be revisited")
// A misclicked "Not me" must not hide one of your own records for good, and a
// misclicked "This is me" must not strand a stranger's record in your queue.
const decided = (id: string, confirmedMine: boolean | null) => store.upsertListing({
  id, brokerId: "fastpeoplesearch", identityId: "id_smoke1", url: `https://example.com/${id}`,
  displayName: "Alice Doe", exposedData: {}, confirmedMine,
  firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
})
decided("lst_rejected", false)
check("a rejected listing returns to review",
  store.returnListingToReview("lst_rejected") && store.getListing("lst_rejected")?.confirmedMine === null)
decided("lst_confirmed", true)
check("a confirmed listing with no request returns to review",
  store.returnListingToReview("lst_confirmed") && store.getListing("lst_confirmed")?.confirmedMine === null)
let inFlightRefused = false
try { store.returnListingToReview("lst_s1") } catch { inFlightRefused = true }
check("a listing with an active request keeps its decision",
  inFlightRefused && store.getListing("lst_s1")?.confirmedMine === true)
check("returning an unknown listing is reported", store.returnListingToReview("lst_missing") === false)
check("confirming an unknown listing is reported", store.setListingConfirmed("lst_missing", true) === false)

console.log("smoke: durable scan progress")
const scan = store.createScanRun("id_smoke1", "rescan")
scan.results.push({
  brokerId: "whitepages",
  ok: true,
  outcome: "found",
  listingsFound: 1,
})
scan.events.push({
  listingId: "lst_s1",
  brokerId: "whitepages",
  type: "still_listed",
  recordedAt: new Date().toISOString(),
})
check("partial progress persisted", store.saveScanRunProgress(scan))
const resumableScan = store.getScanRun(scan.id)
check("unfinished scan can be loaded", resumableScan?.finishedAt === undefined)
check("scan kind survives reload", resumableScan?.kind === "rescan")
check("completed broker survives reload", resumableScan?.results[0]?.brokerId === "whitepages")
check("tri-state outcome survives reload", resumableScan?.results[0]?.outcome === "found")
check("listing events survive reload", resumableScan?.events[0]?.type === "still_listed")
if (resumableScan) store.finishScanRun(resumableScan)
check("finished scan is timestamped", Boolean(store.getScanRun(scan.id)?.finishedAt))

console.log("smoke: conservative rescan history")
store.updateSubmission(sub.id, { status: "confirmed" })
const inconclusiveEvents = store.recordBrokerScanObservation({
  identityId: "id_smoke1",
  brokerId: "whitepages",
  runKind: "rescan",
  observation: {
    outcome: "inconclusive",
    listings: [],
    issueCode: "challenge",
    detail: "test challenge",
  },
  evidenceDir: join(tempRoot, "evidence", "inconclusive"),
})
check("inconclusive rescan creates no absence event", inconclusiveEvents.length === 0)
check("inconclusive rescan keeps listing visible", store.getListing("lst_s1")?.presenceStatus === "seen")
check("inconclusive rescan keeps submission status", store.listSubmissions("lst_s1")[0]?.status === "confirmed")

const clearEvidenceDir = join(tempRoot, "evidence", "clear")
const clearRun = store.createScanRun("id_smoke1", "rescan")
const clearResult = {
  brokerId: "whitepages",
  ok: true,
  outcome: "clear" as const,
  listingsFound: 0,
  evidenceDir: clearEvidenceDir,
}
const clearInput = {
  identityId: "id_smoke1",
  brokerId: "whitepages",
  runKind: "rescan" as const,
  observation: { outcome: "clear" as const, listings: [] },
  evidenceDir: clearEvidenceDir,
  runId: clearRun.id,
  result: clearResult,
}
const clearEvents = store.recordBrokerScanObservation(clearInput)
const absentListing = store.getListing("lst_s1")
const removedSubmission = store.listSubmissions("lst_s1")[0]
const checkpointedClearRun = store.getScanRun(clearRun.id)
check("conclusive clear retains listing history", Boolean(absentListing))
check("conclusive clear marks listing absent", absentListing?.presenceStatus === "absent")
check("conclusive clear timestamps absence", Boolean(absentListing?.lastAbsentAt))
check("conclusive clear records removal", clearEvents[0]?.type === "removed")
check("conclusive clear marks actioned submission removed", removedSubmission?.status === "removed")
check("verified removal timestamp is retained", Boolean(removedSubmission?.removedVerifiedAt))
check("listing transition and broker result commit together", checkpointedClearRun?.events[0]?.type === "removed")
check("atomic checkpoint retains evidence directory", checkpointedClearRun?.results[0]?.evidenceDir === clearEvidenceDir)
check("duplicate broker checkpoint is rejected", (() => {
  try {
    store.recordBrokerScanObservation(clearInput)
    return false
  } catch {
    return true
  }
})())
check("duplicate checkpoint cannot rewrite transition", store.getScanRun(clearRun.id)?.events.length === 1)
if (checkpointedClearRun) store.finishScanRun(checkpointedClearRun)

const relistedEvents = store.recordBrokerScanObservation({
  identityId: "id_smoke1",
  brokerId: "whitepages",
  runKind: "rescan",
  observation: {
    outcome: "found",
    listings: [{
      id: "lst_replacement_id",
      brokerId: "whitepages",
      identityId: "id_smoke1",
      url: "https://example.com/a/",
      displayName: "Alice Doe",
      exposedData: {},
      confirmedMine: null,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }],
  },
  evidenceDir: join(tempRoot, "evidence", "relisted"),
})
const relistedListing = store.getListing("lst_s1")
check("canonical URL keeps original listing id", relistedListing?.id === "lst_s1")
check("relisted record is visible again", relistedListing?.presenceStatus === "seen")
check("relisted record keeps user confirmation", relistedListing?.confirmedMine === true)
check("relisted transition is recorded", relistedEvents[0]?.type === "relisted")
check("relisting does not rewrite old removal receipt", store.listSubmissions("lst_s1")[0]?.status === "removed")

store.upsertListing({
  id: "lst_s1_other",
  brokerId: "whitepages",
  identityId: "id_smoke1",
  url: "https://example.com/other",
  displayName: "Alice Doe",
  exposedData: {},
  confirmedMine: true,
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
})
store.recordBrokerScanObservation({
  identityId: "id_smoke1",
  brokerId: "whitepages",
  runKind: "rescan",
  observation: {
    outcome: "found",
    listings: [{
      id: "lst_s1",
      brokerId: "whitepages",
      identityId: "id_smoke1",
      url: "https://example.com/a",
      displayName: "Alice Doe",
      exposedData: {},
      confirmedMine: true,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }],
  },
  evidenceDir: join(tempRoot, "evidence", "positive-partial"),
})
check(
  "positive search cannot mark an unreturned prior listing absent",
  store.getListing("lst_s1_other")?.presenceStatus === "seen",
)

console.log("smoke: delete-identity is transactional")
const dirs1 = store.deleteIdentity("id_smoke1")
check("identity gone", store.getIdentity("id_smoke1") === undefined)
check("its listings gone", store.listListings("id_smoke1").length === 0)
check("its submissions gone", store.listSubmissions("lst_s1").length === 0)
check("its scan runs gone", store.listScanRuns("id_smoke1").length === 0)
check("other identity untouched", store.getIdentity("id_smoke2")?.fullName === "Bob Roe")
check("other listing untouched", store.listListings("id_smoke2").length === 1)
check("delete of unknown identity throws", (() => {
  try {
    store.deleteIdentity("id_nonexistent")
    return false
  } catch {
    return true
  }
})())
check(
  "latest listing evidence directory is collected for cleanup",
  dirs1.includes(join(tempRoot, "evidence", "positive-partial")),
)
check("scan-level clear evidence is collected for cleanup", dirs1.includes(clearEvidenceDir))

console.log("smoke: one active scan per identity")
const activeScan = store.createScanRun("id_smoke2", "scan")
check("second unfinished scan is rejected", (() => {
  try {
    store.createScanRun("id_smoke2", "rescan")
    return false
  } catch {
    return true
  }
})())
store.finishScanRun(activeScan)

console.log("smoke: reset-all")
store.resetAll()
check("all identities gone", store.listIdentities().length === 0)
check("all listings gone", store.listListings().length === 0)
check("all submissions gone", store.listSubmissions().length === 0)
check("scan runs still empty-table safe", store.listScanRuns().length === 0)

console.log("smoke: cleanup jail refuses outside paths")
const cleanup = await import("../src/engine/cleanup.ts")
mkdirSync(join(tempRoot, "evidence", "run-1"), { recursive: true })
writeFileSync(join(tempRoot, "evidence", "run-1", "shot.png"), "x")
check("jailed path removed", cleanup.removeEvidencePath(join(tempRoot, "evidence", "run-1")) === true)
check("outside path refused", cleanup.removeEvidencePath(join(tmpdir(), "some-other-file.txt")) === false)
check("evidence root itself refused", cleanup.removeEvidencePath(join(tempRoot, "evidence")) === false)

// A lexically-jailed path can still escape through a symlinked directory:
// evidence/linked/secret.txt resolves outside the jail if "linked" points out.
const outside = join(tempRoot, "outside")
mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, "secret.txt"), "must survive")
symlinkSync(outside, join(tempRoot, "evidence", "linked"), "junction")
check(
  "path through a symlink out of the jail is refused",
  cleanup.removeEvidencePath(join(tempRoot, "evidence", "linked", "secret.txt")) === false,
)
check("file outside the jail survives", existsSync(join(outside, "secret.txt")))
check("removing the symlink itself succeeds", cleanup.removeEvidencePath(join(tempRoot, "evidence", "linked")) === true)
check("removing the symlink never deletes its target", existsSync(join(outside, "secret.txt")))

store.closeDb()
try {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
} catch {
  // Windows can still hold a handle briefly; the temp dir is disposable.
}

console.log("")
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
} else {
  console.log("all store smoke checks passed ✓")
}
process.exit(0)
