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
import { buildRedactionMap, redactListing, redactText } from "./redact.ts"
import { keyStatus } from "../config/setup.ts"

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
  const apiKey = process.env.GROQ_API_KEY?.trim()
  if (!apiKey || keyStatus(apiKey) !== "configured") {
    throw new Error(
      "GROQ_API_KEY is not set. Exposure scoring is optional — add a key from https://console.groq.com to .env",
    )
  }

  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b"
  const groq = new Groq({ apiKey })
  const map = buildRedactionMap(identity, listings)

  const listingBlocks = listings
    .map((l, i) => `--- listing ${i} ---\n${redactListing(l, map)}`)
    .join("\n\n")

  // Preserve region-level scoring context without sending literal location values.
  const context = redactText(
    `subject_location: ${identity.city}, state ${identity.stateCode}`,
    map,
  )

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
  return parseExposureReport(raw, listings, model)
}

/** Turn the model's raw reply into a report. Pure, so it is testable without a provider. */
export function parseExposureReport(raw: string, listings: Listing[], model: string): ExposureReport {
  const parsed = safeParseJson(raw)
  if (!parsed) throw new Error("Exposure scoring: model returned unparseable JSON")

  // The reply is untrusted: indices can repeat or point past the list, and
  // scores can be missing or non-numeric. Unchecked, those surface as
  // "unknown" listings, double-count in the average, or turn it into NaN.
  const seen = new Set<number>()
  const rankings: ListingRisk[] = []
  for (const r of Array.isArray(parsed.rankings) ? parsed.rankings : []) {
    const index = r?.listing_index
    const score = finiteScore(r?.score)
    if (!Number.isInteger(index) || index < 0 || index >= listings.length || seen.has(index)) continue
    if (score === undefined) continue
    seen.add(index)
    rankings.push({
      listingId: listings[index].id,
      brokerId: listings[index].brokerId,
      score: Math.max(0, Math.min(100, Math.round(score))),
      rationale: String(r.rationale ?? "").slice(0, 500),
      recommendedAction: String(r.recommended_action ?? "").slice(0, 300),
    })
  }
  // With nothing usable, the average would read 0/100: "no exposure".
  if (listings.length > 0 && rankings.length === 0) {
    throw new Error("Exposure scoring: model returned no usable rankings")
  }

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

/** A number, or a string that is exactly one. Never coerces null or "" to 0. */
function finiteScore(value: unknown): number | undefined {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
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
