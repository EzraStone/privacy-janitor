/**
 * PII redaction for LLM prompts.
 *
 * A privacy tool must not leak the very data it protects. Before any prompt
 * leaves the machine, we tokenize identity values into opaque placeholders,
 * score the STRUCTURE of exposure, and map results back locally.
 *
 * The LLM sees: "[NAME_1] appears on Broker B with [ADDR_1], [PHONE_1] and
 * two relatives." Tokenization reduces disclosure; it is not a guarantee of
 * anonymity or protection against every future field or unrecognized format.
 */
import type { Identity, Listing } from "@/types"

export interface RedactionMap {
  /** token -> original value */
  tokenToValue: Map<string, string>
  /** original value (lowercased) -> token */
  valueToToken: Map<string, string>
}

type TokenKind = "LOCATION" | "NAME" | "RELATIVE" | "ADDR" | "PHONE" | "EMAIL"

/** Build the token map for an identity + its listings. */
export function buildRedactionMap(identity: Identity, listings: Listing[]): RedactionMap {
  // Each value is typed by the field it came from, never guessed from its
  // content: a ZIP code made full addresses look like phone numbers, and a
  // relative named "Lane" looked like a street. The first field to claim a
  // value decides its type, so the profile's city and state stay LOCATION
  // when they reappear inside an address.
  const typed: Array<[string, TokenKind]> = [
    [identity.fullName, "NAME"],
    [identity.city, "LOCATION"],
    [identity.stateCode, "LOCATION"],
  ]
  identity.relatives?.forEach((r) => typed.push([r, "RELATIVE"]))

  for (const l of listings) {
    typed.push([l.displayName, "NAME"])
    l.exposedData.aliases?.forEach((a) => typed.push([a, "NAME"]))
    l.exposedData.relatives?.forEach((r) => typed.push([r, "RELATIVE"]))
    l.exposedData.addresses?.forEach((a) => {
      typed.push([a, "ADDR"])
      // Also register each comma-separated segment so PARTIAL addresses
      // ("742 Evergreen Terrace") redact even when the full value with
      // city/state doesn't appear verbatim.
      a.split(",").map((s) => s.trim()).filter((s) => s.length > 3).forEach((seg) => typed.push([seg, "ADDR"]))
    })
    l.exposedData.phones?.forEach((p) => typed.push([p, "PHONE"]))
    l.exposedData.emails?.forEach((e) => typed.push([e, "EMAIL"]))
  }

  const tokenToValue = new Map<string, string>()
  const valueToToken = new Map<string, string>()
  const counts: Record<TokenKind, number> = { LOCATION: 0, NAME: 0, RELATIVE: 0, ADDR: 0, PHONE: 0, EMAIL: 0 }

  for (const [value, kind] of typed) {
    // Profiles saved before server-side trimming can hold blank values; a
    // blank key would become an empty pattern that matches at every position.
    if (!value.trim()) continue
    const key = value.toLowerCase()
    if (valueToToken.has(key)) continue
    const token = `[${kind}_${++counts[kind]}]`
    tokenToValue.set(token, value)
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
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Short values such as state codes must match whole values, not the
    // same letters inside an unrelated word (for example, "WA" in "awaiting").
    const leftBoundary = /^[a-z0-9]/i.test(value) ? "(?<![a-z0-9])" : ""
    const rightBoundary = /[a-z0-9]$/i.test(value) ? "(?![a-z0-9])" : ""
    out = out.replace(new RegExp(`${leftBoundary}${escaped}${rightBoundary}`, "gi"), token)
  }
  return out
}

/** Map tokens in model output back to real values, locally, after the call.
 *  Tokens the model invented have no value and are left as written. */
export function restoreText(text: string, map: RedactionMap): string {
  return text.replace(/\[[A-Z]+_\d+\]/g, (token) => map.tokenToValue.get(token) ?? token)
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
  if (e.age) parts.push(`age_band: ${/^\d{1,3}\s*-\s*\d{1,3}$/.test(e.age) ? e.age : "single_value"}`)
  return parts.join("\n")
}
