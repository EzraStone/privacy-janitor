/** Synthetic selector fixtures driving the real adapters. No browser, credentials, or network. */
import assert from "node:assert/strict"
import { explainListing } from "../src/adapters/helpers.ts"
import { adapters } from "../src/adapters/registry.ts"
import type { BrokerPage, BrokerLocator, Identity, Listing, PreparedOptOut } from "../src/types.ts"

type Element = { text?: string; href?: string; hidden?: boolean; onClick?: () => void }
type Fixture = Record<string, Element[]>
const person: Identity = { id: "fixture", fullName: "Jordan Example", city: "Chicago", stateCode: "IL", createdAt: "2026-09-10T00:00:00Z" }
const prepared: PreparedOptOut = { submissionId: "fixture", listingId: "fixture", brokerId: "fixture", state: {}, createdAt: person.createdAt }

function fixturePage(search: Fixture, profile: Fixture = {}): BrokerPage & { clicks: string[]; fields: Record<string, string>; navigations: string[] } {
  let current = search
  let address = "https://fixture.invalid"
  const clicks: string[] = []
  const fields: Record<string, string> = {}
  const navigations: string[] = []
  function locator(selector: string, index?: number): BrokerLocator {
    const all = () => current[selector] ?? []
    const selected = () => index === undefined ? all() : all().slice(index, index + 1)
    const element = () => { const found = selected()[0]; if (!found) throw new Error(`Missing fixture selector: ${selector}`); return found }
    return {
      async click() { clicks.push(selector); element().onClick?.() },
      async fill(value) { element(); fields[selector] = value },
      async type(value) { element(); fields[selector] = value },
      async selectOption(value) { element(); fields[selector] = JSON.stringify(value) },
      async press() { element() },
      first: () => locator(selector, 0), nth: (n) => locator(selector, n),
      async waitFor() { element() },
      async innerText() { return element().text ?? "" },
      async allInnerTexts() { return selected().map((e) => e.text ?? "") },
      async count() { return selected().length },
      async isVisible() { return !!selected()[0] && !selected()[0].hidden },
      async getAttribute(name) { return name === "href" ? element().href ?? null : null },
    }
  }
  return {
    clicks, fields, navigations, locator,
    async goto(url) {
      address = url; navigations.push(url)
      current = /\/name\/[^/]+\/[^/]+\/[^/]+$|\/p\d+$|_id_G-?\d+$/i.test(url) ? profile : search
    },
    async waitForTimeout() {}, url: () => address,
    async screenshot() { return Buffer.from(current === search ? "synthetic search" : "synthetic profile") },
  }
}

// Each adapter's first selector per profile field, and a later fallback.
const extraction: Record<string, {
  address: string; phone: [string, string]; age: [string, string]; relative: [string, string]; email?: string
}> = {
  whitepages: {
    address: '[data-testid="address"]', phone: ['[data-testid="phone"]', 'a[href^="tel:"]'],
    age: ['[data-testid="age"]', ".age"], relative: ['[data-testid="relative"]', ".relative"],
  },
  spokeo: {
    address: '[data-testid="address"]', phone: ['[data-testid="phone"]', ".phone"],
    age: ['[data-testid="age"]', ".age"], relative: ['a[href*="-F"]', '[data-testid="relative"]'], email: '[data-testid="email"]',
  },
  fastpeoplesearch: {
    address: '[class*="address" i]', phone: ['a[href*="/phone/"]', 'a[href^="tel:"]'],
    age: ['[class*="age" i]', 'span:has-text("Age")'], relative: ['a[href*="/name/"]', '[class*="relative" i]'],
  },
}

let cases = 0
for (const adapter of adapters) {
  const profileUrl = adapter.id === "whitepages" ? "/name/Jordan-Example/Chicago-IL/fixture"
    : adapter.id === "spokeo" ? "/Jordan-Example/Illinois/Chicago/p123" : "/jordan-example_id_G-123"
  const anchor = adapter.id === "whitepages" ? 'a[href*="/name/"]' : "a"
  const base: Fixture = {
    "#search-name": [{}], "#search-name-name": [{}], '#homepage_hero_form input[name="q"]': [{}],
    "#search-location": [{}], "#search-name-address": [{}],
    body: [{ text: "Search results" }],
  }
  const noResult = '[class*="no-result" i]'
  const scenarios: Array<[string, Fixture, "found" | "clear" | "inconclusive", Fixture?]> = [
    ["explicit clear", { [noResult]: [{ text: "No results found" }] }, "clear"],
    ["body phrase is not evidence", { body: [{ text: "FAQ: no results found? Try again." }] }, "inconclusive"],
    ["ten results is not zero", { [noResult]: [{ text: "10 results" }] }, "inconclusive"],
    ["hidden clear", { [noResult]: [{ text: "No results found", hidden: true }] }, "inconclusive"],
    ["challenge wins", { body: [{ text: "Verify you are human" }], [noResult]: [{ text: "No results found" }] }, "inconclusive"],
    ["pagination", { [noResult]: [{ text: "No results found" }], 'a[rel="next"]': [{}] }, "inconclusive"],
    ["verified profile", { [anchor]: [{ href: profileUrl }] }, "found", { h1: [{ text: person.fullName }], body: [{ text: person.fullName }] }],
    ["profile challenge", { [anchor]: [{ href: profileUrl }] }, "inconclusive", { h1: [{ text: person.fullName }], body: [{ text: "Access denied" }] }],
    ["missing profile", { [anchor]: [{ href: profileUrl }] }, "inconclusive", {}],
    ["loading profile", { [anchor]: [{ href: profileUrl }] }, "inconclusive", { h1: [{ text: "Loading Search Results..." }] }],
    ["namesake link", { [anchor]: [{ href: profileUrl.replace(/Jordan|jordan/, "Someone") }] }, "inconclusive"],
    ["foreign domain", { [anchor]: [{ href: `https://unrelated.invalid${profileUrl}` }] }, "inconclusive"],
  ]
  for (const [label, fixture, expected, profile] of scenarios) {
    const result = await adapter.scan(fixturePage({ ...base, ...fixture }, profile), person)
    assert.equal(result.outcome, expected, `${adapter.id}: ${label}`)
    assert.equal(result.listings.length, expected === "found" ? 1 : 0, `${adapter.id}: no fabricated profiles (${label})`)
    assert.equal(result.searchScreenshot?.toString(), "synthetic search", "search evidence captured before profile navigation")
    cases++
  }

  // What a verified profile exposes, read through the adapter's own selectors.
  const fields = extraction[adapter.id]
  async function scanProfile(profile: Fixture): Promise<Listing> {
    const result = await adapter.scan(fixturePage({ ...base, [anchor]: [{ href: profileUrl }] },
      { h1: [{ text: person.fullName }], body: [{ text: person.fullName }], ...profile }), person)
    assert.equal(result.listings.length, 1, `${adapter.id}: one verified profile`)
    return result.listings[0]
  }
  const address = "742 Evergreen Terrace, Chicago, IL 60601"
  const direct = await scanProfile({
    [fields.address]: [{ text: address }],
    [fields.phone[0]]: [{ text: "(312) 555-0142" }, { text: "312-555-0142" }],
    [fields.age[0]]: [{ text: "Age 42" }],
    [fields.relative[0]]: [{ text: "Casey Example" }, { text: "Relatives, associates and neighbors of Jordan Example in Chicago, Illinois" }],
    ...(fields.email ? { [fields.email]: [{ text: "jordan@example.com" }, { text: "privacy@spokeo.com" }] } : {}),
  })
  assert.deepEqual(direct.exposedData, {
    addresses: [address], phones: ["(312) 555-0142"], age: "42", relatives: ["Casey Example"],
    ...(fields.email ? { emails: ["jordan@example.com"] } : {}),
  }, `${adapter.id}: profile details are extracted and normalized`)
  assert.deepEqual(explainListing(direct, { ...person, ageRange: "40-45", relatives: ["Casey Example"] }),
    { name: "same", place: "city_and_state", age: "fits", relatives: "shared" }, `${adapter.id}: extracted details feed the match hint`)
  // Loose fallbacks such as [class*="age"] also match "page" and "image":
  // junk under one selector must not hide real data under the next.
  const chrome: Fixture = {
    [fields.phone[0]]: [{ text: "Reverse phone lookup" }],
    [fields.age[0]]: [{ text: "Page 1 of 3" }],
    [fields.relative[0]]: [{ text: "Jordan Example\nAge 42\n742 Evergreen Terrace" }],
  }
  const fallback = await scanProfile({
    ...chrome,
    [fields.phone[1]]: [{ text: "(312) 555-0142" }], [fields.age[1]]: [{ text: "Age 42" }], [fields.relative[1]]: [{ text: "Casey Example" }],
  })
  assert.deepEqual(fallback.exposedData, { phones: ["(312) 555-0142"], age: "42", relatives: ["Casey Example"] },
    `${adapter.id}: junk under one selector does not hide the next`)
  assert.deepEqual((await scanProfile(chrome)).exposedData, {}, `${adapter.id}: page chrome is not personal data`)
  cases += 3

  const submit = 'button:has-text("Submit")'
  const status = '[role="status"]'
  const listing: Listing = {
    id: "fixture", identityId: person.id, brokerId: adapter.id, url: `${adapter.homepage}${profileUrl}`,
    displayName: person.fullName, exposedData: {}, confirmedMine: true,
    firstSeenAt: person.createdAt, lastSeenAt: person.createdAt,
  }
  const form: Fixture = {
    "#suppression-requests-person-url": [{}], 'button:has-text("Next")': [{}],
    'input[name="url"]': [{}], 'input[name="email"]': [{}],
    'input#firstname': [{}], 'input#lastname': [{}], [submit]: [{}],
  }
  const previewPage = fixturePage(form)
  const preview = await adapter.prepareOptOut(previewPage, listing, person, "jordan@example.com")
  assert.ok(preview.screenshot.length)
  assert.ok(preview.summary.includes("jordan@example.com"))
  assert.ok(Object.values(previewPage.fields).includes("jordan@example.com"))
  assert.ok(!previewPage.clicks.includes(submit), "preparation must not submit a removal")
  await assert.rejects(adapter.prepareOptOut(fixturePage({ ...form, 'input[name="email"]': [] }), listing, person, "jordan@example.com"), /email field/)
  cases += 2
  for (const [message, accepted] of [
    ["Your request has been received. Check your email for the confirmation link.", true],
    ["Opt out", false], ["", false], ["Your request was not submitted.", false],
    ["Click submit to get your request received.", false],
  ] as const) {
    const page = fixturePage({ [submit]: [{}], [status]: [{ text: message }] })
    if (accepted) assert.equal((await adapter.submitOptOut(page, prepared)).ok, true)
    else await assert.rejects(adapter.submitOptOut(page, prepared))
    assert.equal(page.clicks.length, 1)
    cases++
  }
  const ambiguous = fixturePage({
    [submit]: [{ onClick: () => { throw new Error("connection lost after click") } }],
    'button[type="submit"]': [{}], 'input[type="submit"]': [{}],
  })
  await assert.rejects(adapter.submitOptOut(ambiguous, prepared), /connection lost/)
  assert.deepEqual(ambiguous.clicks, [submit], "no selector fallback after an ambiguous click")
  cases++
  const confirming = 'button:has-text("Confirm")'
  const interruptedConfirmation = fixturePage({
    [confirming]: [{ onClick: () => { throw new Error("confirmation connection lost") } }],
    'a:has-text("Confirm")': [{}],
  })
  await assert.rejects(adapter.confirmByEmail!(interruptedConfirmation, `${adapter.homepage}/confirm`), /connection lost/)
  assert.deepEqual(interruptedConfirmation.clicks, [confirming])
  cases++
  for (const [fixture, accepted] of [
    [{ [status]: [{ text: "Your request has been confirmed. Removal in progress." }] }, true],
    [{ [status]: [{ text: "Your profile has been removed." }] }, true],
    [{ [status]: [{ text: "Check your email for the confirmation link." }] }, false],
    [{ [status]: [{ text: "Confirmation link expired." }] }, false],
    [{ [status]: [{ text: "Your request has been confirmed." }], body: [{ text: "Verify you are human" }] }, false],
    [{ [status]: [{ text: "Your request has been confirmed." }], 'input[type="email"]': [{}] }, false],
    [{ [status]: [{ text: "Your request has been confirmed." }, { text: "Unable to process request." }] }, false],
    [{}, false],
  ] satisfies Array<[Fixture, boolean]>) {
    const page = fixturePage(fixture)
    if (accepted) await adapter.confirmByEmail!(page, `${adapter.homepage}/confirm?synthetic=1`)
    else await assert.rejects(adapter.confirmByEmail!(page, `${adapter.homepage}/confirm?synthetic=1`))
    cases++
  }
  console.log(`adapter fixtures: ${adapter.name} passed`)
}
console.log(`${cases} offline adapter behavior checks passed (not live broker validation)`)
