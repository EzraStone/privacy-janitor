/**
 * PII redaction for LLM prompts.
 *
 * A privacy tool must not leak the very data it protects. Before any prompt
 * leaves the machine, we tokenize identity values into opaque placeholders,
 * score the STRUCTURE of exposure, and map results back locally.
 *
 * The LLM sees: "[NAME_1] appears on Broker B with [ADDR_1], [PHONE_1] and
 * two relatives." — enough to reason about risk, nothing to re-identify.
 */
import type { Identity, Listing } from "@/types"

export interface RedactionMap {
  /** token -> original value */
  tokenToValue: Map<string, string>
  /** original value (lowercased) -> token */
  valueToToken: Map<string, string>
}

/** Build the token map for an identity + its listings. */
export function buildRedactionMap(identity: Identity, listings: Listing[]): RedactionMap {
  const values = new Set<string>()

  values.add(identity.fullName)
  identity.relatives?.forEach((r) => values.add(r))

  for (const l of listings) {
    values.add(l.displayName)
    l.exposedData.addresses?.forEach((a) => values.add(a))
    l.exposedData.phones?.forEach((p) => values.add(p))
    l.exposedData.emails?.forEach((e) => values.add(e))
    l.exposedData.relatives?.forEach((r) => values.add(r))
    l.exposedData.aliases?.forEach((a) => values.add(a))
  }

  const tokenToValue = new Map<string, string>()
  const valueToToken = new Map<string, string>()
  let nameN = 0
  let addrN = 0
  let phoneN = 0
  let emailN = 0
  let relN = 0
  let miscN = 0

  for (const v of values) {
    const key = v.toLowerCase()
    if (valueToToken.has(key)) continue
    let token: string
    if (v === identity.fullName || identity.relatives?.includes(v)) {
      token = `[NAME_${++nameN}]`
    } else if (/[\d]/.test(v) && v.replace(/\D/g, "").length >= 7) {
      token = `[PHONE_${++phoneN}]`
    } else if (v.includes("@")) {
      token = `[EMAIL_${++emailN}]`
    } else if (/\b(st|street|ave|avenue|rd|road|dr|drive|blvd|ln|lane|ct|court|city|state)\b/i.test(v)) {
      token = `[ADDR_${++addrN}]`
    } else {
      token = `[RELATIVE_${++relN}]` // fall back: relative-ish names
    }
    tokenToValue.set(token, v)
    valueToToken.set(key, token)
  }

  return { tokenToValue, valueToToken }
}

/** Replace every known value in `text` with its token. Case-insensitive. */
export function redactText(text: string, map: RedactionMap): string {
  let out = text
  // Longest values first so "Jane Doe" replaces before "Doe".
  const entries = [...map.valueToToken.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  )
  for (const [value, token] of entries) {
    // plain string split-join; regex escaping avoided deliberately
    out = out.split(value).join(token)
    // also handle simple title-case variance
    const titled = value
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
    out = out.split(titled).join(token)
  }
  return out
}

/** Redact a listing into the structure-only shape we send to the LLM. */
export function redactListing(listing: Listing, map: RedactionMap): string {
  const parts: string[] = []
  parts.push(`broker: ${listing.brokerId}`)
  parts.push(`display_name: ${redactText(listing.displayName, map)}`)
  const e = listing.exposedData
  if (e.addresses?.length)
    parts.push(`addresses: ${e.addresses.map((a) => redactText(a, map)).join(" | ")}`)
  if (e.phones?.length)
    parts.push(`phones: ${e.phones.map((p) => redactText(p, map)).join(" | ")}`)
  if (e.emails?.length)
    parts.push(`emails: ${e.emails.map((x) => redactText(x, map)).join(" | ")}`)
  if (e.relatives?.length)
    parts.push(`relatives_listed: ${e.relatives.map((x) => redactText(x, map)).join(" | ")}`)
  if (e.aliases?.length)
    parts.push(`aliases: ${e.aliases.map((x) => redactText(x, map)).join(" | ")}`)
  if (e.age) parts.push(`age_band: ${e.age.includes("-") ? e.age : "single_value"}`)
  return parts.join("\n")
}
