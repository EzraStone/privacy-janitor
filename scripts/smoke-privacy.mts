import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blockedArtifact, checkIndex, containsProviderKey } from "./check-repo-data.mts"
import { buildRedactionMap, redactListing } from "../src/scoring/redact.ts"
import type { Identity, Listing } from "../src/types.ts"

for (const path of ["data/profile.json", "evidence/scan.png", "traces/session.zip", ".env", ".env.local", "nested/.env", "backup.db", "backup.db-wal", "backup.sqlite-shm", "session.har", "debug.log"]) {
  assert.equal(blockedArtifact(path), true, path)
}
for (const path of [".env.example", "src/store/index.ts", "src/app/api/evidence/route.ts", "docs/images/profile-form-demo.png", "scripts/smoke-store.mts"]) {
  assert.equal(blockedArtifact(path), false, path)
}
for (const prefix of ["slr_live_", "gsk_"]) {
  assert.equal(containsProviderKey(prefix + "x".repeat(24)), false)
  assert.equal(containsProviderKey(prefix + "Ab12Cd34".repeat(4)), true)
}
assert.equal(containsProviderKey("-----BEGIN " + "PRIVATE KEY-----"), true)
// The index guard must read every text file, whatever its extension: a key
// pasted into a shell script leaks as surely as one in TypeScript.
const repo = mkdtempSync(join(tmpdir(), "pj-guard-"))
try {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
  git("init", "-q")
  writeFileSync(join(repo, "clean.ts"), "export const ok = 1\n")
  writeFileSync(join(repo, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  git("add", ".")
  assert.equal(checkIndex(repo), 0, "a clean index passes and media is skipped")
  writeFileSync(join(repo, "setup.sh"), `export SOLARI_API_KEY=${"slr_live_" + "Ab12Cd34".repeat(4)}\n`)
  git("add", "setup.sh")
  assert.equal(checkIndex(repo), 1, "a key in a shell script is caught")
} finally {
  rmSync(repo, { recursive: true, force: true })
}
const identity: Identity = { id: "fixture", fullName: "Jordan Example", city: "Chicago", stateCode: "IL", createdAt: "2026-09-10T00:00:00Z" }
const listing: Listing = {
  id: "fixture", brokerId: "spokeo", identityId: identity.id, url: "https://fixture.invalid",
  displayName: identity.fullName, exposedData: { age: "private-name@example.com" },
  confirmedMine: true, firstSeenAt: identity.createdAt, lastSeenAt: identity.createdAt,
}
assert.ok(!redactListing(listing, buildRedactionMap(identity, [listing])).includes("private-name"), "unexpected age text must not bypass tokenization")
listing.exposedData.age = "30-35"
assert.ok(redactListing(listing, buildRedactionMap(identity, [listing])).includes("30-35"))
console.log("Privacy guard checks passed: blocked artifacts, credential detection, every text file scanned, safe placeholders, age-field minimization")
