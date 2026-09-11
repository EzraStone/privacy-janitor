import assert from "node:assert/strict"
import { blockedArtifact, containsProviderKey } from "./check-repo-data.mts"
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
const identity: Identity = { id: "fixture", fullName: "Jordan Example", city: "Chicago", stateCode: "IL", createdAt: "2026-09-10T00:00:00Z" }
const listing: Listing = {
  id: "fixture", brokerId: "spokeo", identityId: identity.id, url: "https://fixture.invalid",
  displayName: identity.fullName, exposedData: { age: "private-name@example.com" },
  confirmedMine: true, firstSeenAt: identity.createdAt, lastSeenAt: identity.createdAt,
}
assert.ok(!redactListing(listing, buildRedactionMap(identity, [listing])).includes("private-name"), "unexpected age text must not bypass tokenization")
listing.exposedData.age = "30-35"
assert.ok(redactListing(listing, buildRedactionMap(identity, [listing])).includes("30-35"))
console.log("Privacy guard checks passed: blocked artifacts, credential detection, safe placeholders, age-field minimization")
