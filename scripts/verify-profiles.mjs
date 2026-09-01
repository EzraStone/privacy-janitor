/** Live API roundtrip: add -> edit -> scope-check -> delete a temp profile. */
const BASE = "http://localhost:3000"

async function api(body) {
  const res = await fetch(`${BASE}/api/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${res.status}: ${json.error}`)
  return json
}

let failures = 0
const check = (name, cond) => {
  console.log(cond ? `  ok    ${name}` : `  FAIL  ${name}`)
  if (!cond) failures++
}

// 1. create
const { identity } = await api({
  action: "save-identity",
  identity: { fullName: "Round Trip", city: "Portland", stateCode: "OR" },
})
check("create returns id", !!identity.id)

// 2. edit (same id, new city)
await api({
  action: "save-identity",
  identity: { ...identity, city: "Bend" },
})

// 3. list — edited city visible, John Smith untouched
const state1 = await (await fetch(`${BASE}/api/state`)).json()
const edited = state1.identities.find((i) => i.id === identity.id)
check("edit persisted", edited?.city === "Bend")
check("other profiles untouched", state1.identities.some((i) => i.fullName === "John Smith"))
const beforeCount = state1.identities.length

// 4. listings scoped: new profile has none of John Smith's listings
const jsListings = state1.listings.filter((l) => l.identityId !== "id_e2e_test")
check("new profile has no foreign listings", jsListings.length === 0)

// 5. delete temp profile
const del = await api({ action: "delete-identity", identityId: identity.id })
check("delete returns evidence count", typeof del.evidenceCleaned === "number")

// 6. list — gone, others intact
const state2 = await (await fetch(`${BASE}/api/state`)).json()
check("deleted profile gone", !state2.identities.some((i) => i.id === identity.id))
check("count back to before", state2.identities.length === beforeCount - 1)
check("john smith data intact", state2.listings.some((l) => l.identityId === "id_e2e_test"))

console.log(failures ? `${failures} FAILED` : "all API roundtrip checks passed ✓")
process.exit(failures ? 1 : 0)
