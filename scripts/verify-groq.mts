/** Verify Groq scoring end-to-end with synthetic listings (no Solari needed). */
import "dotenv/config"
import { scoreExposure } from "../src/scoring/index.ts"
import type { Identity, Listing } from "../src/types.ts"

const identity: Identity = {
  id: "id_groq_test",
  fullName: "Jane Doe",
  city: "Seattle",
  stateCode: "WA",
  ageRange: "30-35",
  relatives: ["John Doe"],
  createdAt: new Date().toISOString(),
}

const listings: Listing[] = [
  {
    id: "lst_g1",
    brokerId: "whitepages",
    identityId: identity.id,
    url: "https://www.whitepages.com/name/Jane-Doe/x",
    displayName: "Jane Doe",
    exposedData: {
      addresses: ["742 Evergreen Terrace, Seattle, WA"],
      phones: ["(206) 555-0100"],
      relatives: ["John Doe"],
      age: "32",
    },
    confirmedMine: true,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  },
  {
    id: "lst_g2",
    brokerId: "spokeo",
    identityId: identity.id,
    url: "https://www.spokeo.com/Jane-Doe",
    displayName: "Jane M Doe",
    exposedData: {
      addresses: ["742 Evergreen Terrace, Seattle, WA"],
      emails: ["jane.doe@example.com"],
      aliases: ["Jane M Doe", "J Doe"],
    },
    confirmedMine: true,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  },
]

console.log("calling Groq with PII-redacted listings…")
process.env.GROQ_MODEL = "openai/gpt-oss-120b"
const report = await scoreExposure(identity, listings)
console.log("\n=== EXPOSURE REPORT ===")
console.log("total:", report.totalScore, "/ 100")
console.log("summary:", report.summary)
for (const r of report.rankings) {
  console.log(`\n[${r.brokerId}] score ${r.score}/100`)
  console.log("  why:", r.rationale)
  console.log("  action:", r.recommendedAction)
}
console.log("\nmodel:", report.model)
process.exit(0)
