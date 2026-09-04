/**
 * Store transaction tests — exercises delete-identity / reset-all against a
 * THROWAWAY temp database (PJ_DATA_DIR), never the user's real data.
 *
 * Run: node --experimental-strip-types scripts/smoke-store.mts
 */
import "dotenv/config"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tempRoot = mkdtempSync(join(tmpdir(), "pj-smoke-"))
process.env.PJ_DATA_DIR = tempRoot

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

console.log("smoke: durable scan progress")
const scan = store.createScanRun("id_smoke1")
scan.results.push({ brokerId: "whitepages", ok: true, listingsFound: 1 })
check("partial progress persisted", store.saveScanRunProgress(scan))
const resumableScan = store.getScanRun(scan.id)
check("unfinished scan can be loaded", resumableScan?.finishedAt === undefined)
check("completed broker survives reload", resumableScan?.results[0]?.brokerId === "whitepages")
if (resumableScan) store.finishScanRun(resumableScan)
check("finished scan is timestamped", Boolean(store.getScanRun(scan.id)?.finishedAt))

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
check("no evidence dirs collected (none referenced)", dirs1.length === 0)

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
