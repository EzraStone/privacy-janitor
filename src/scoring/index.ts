/**
 * Exposure scoring via Groq (LLaMA 3.x), on PII-redacted listings only.
 *
 * Given all confirmed listings, the model returns a ranked kill list: each
 * listing gets a 0-100 exposure score + a plain-language rationale + the
 * specific data that makes it risky (still tokenized back at render time
 * locally, so the user sees real values).
 */
import Groq from "groq-sdk"
import type { Identity, Listing } from "@/types"
import { buildRedactionMap, redactListing, redactText } from "./redact"

export interface ListingRisk {
  listingId: string
  brokerId: string
  score: number // 0-100
  rationale: string
  recommendedAction: string
}

export interface ExposureReport {
  totalScore: number
  rankings: ListingRisk[]
  summary: string
  generatedAt: string
  model: string
}

interface RawRanking {
  listing_index: number
  score: number
  rationale: string
  recommended_action: string
}

export async function scoreExposure(
  identity: Identity,
  listings: Listing[],
): Promise<ExposureReport> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey || apiKey.startsWith("gsk_xxx")) {
    throw new Error(
      "GROQ_API_KEY is not set. Exposure scoring is optional — add a key from https://console.groq.com to .env",
    )
  }

  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
  const groq = new Groq({ apiKey })
  const map = buildRedactionMap(identity, listings)

  const listingBlocks = listings
    .map((l, i) => `--- listing ${i} ---\n${redactListing(l, map)}`)
    .join("\n\n")

  // Location context at region granularity only, redacted.
  const context = `subject_location: ${redactText(identity.city, map)}, state ${identity.stateCode}`

  const system = `You are a privacy risk analyst. You rank data-broker listings by how dangerous they are to the person listed. All personal values are tokenized placeholders — never attempt to guess or expand them. Respond with strict JSON only.`

  const user = `A person was found on ${listings.length} data-broker site(s). ${context}

${listingBlocks}

Rank every listing by privacy exposure risk (how much it endangers the person: home address visible, phone reachable, relatives mapable, cross-linkable aliases, etc.). Also give ONE overall summary of this person's exposure across all brokers.

Respond as JSON:
{"rankings":[{"listing_index":0,"score":0,"rationale":"...","recommended_action":"..."}],"summary":"..."}

Constraints:
- score: 0-100 integer; higher = more dangerous
- rationale: <=2 short sentences, reference data ONLY by tokens (e.g. "[ADDR_1]")
- recommended_action: one short imperative (e.g. "Remove this listing first — it exposes a current home address.")
- summary: <=4 sentences, tokens only
- valid JSON, no markdown fences, no extra keys`

  const completion = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: 1500,
    // Ask for JSON; LLaMA 3.3 supports response_format on Groq.
    response_format: { type: "json_object" },
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  const parsed = safeParseJson(raw)
  if (!parsed) throw new Error("Exposure scoring: model returned unparseable JSON")

  const rankings: ListingRisk[] = (parsed.rankings ?? [])
    .filter((r: RawRanking) => Number.isInteger(r.listing_index))
    .map((r: RawRanking) => ({
      listingId: listings[r.listing_index]?.id ?? "unknown",
      brokerId: listings[r.listing_index]?.brokerId ?? "unknown",
      score: Math.max(0, Math.min(100, Math.round(r.score))),
      rationale: String(r.rationale ?? "").slice(0, 500),
      recommendedAction: String(r.recommended_action ?? "").slice(0, 300),
    }))

  const totalScore = rankings.length
    ? Math.round(rankings.reduce((s, r) => s + r.score, 0) / rankings.length)
    : 0

  return {
    totalScore,
    rankings: rankings.sort((a, b) => b.score - a.score),
    summary: String(parsed.summary ?? "").slice(0, 1000),
    generatedAt: new Date().toISOString(),
    model,
  }
}

function safeParseJson(text: string): { rankings?: RawRanking[]; summary?: string } | null {
  try {
    return JSON.parse(text)
  } catch {
    // Strip accidental markdown fences and retry.
    const cleaned = text.replace(/```json|```/g, "").trim()
    try {
      return JSON.parse(cleaned)
    } catch {
      return null
    }
  }
}
