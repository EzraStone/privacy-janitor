import "dotenv/config"
import Groq from "groq-sdk"

// Groq's /models response carries fields the SDK's OpenAI-shaped Model type
// omits. Optional, because nothing in the SDK guarantees they stay present.
type GroqModel = Groq.Models.Model & { active?: boolean; context_window?: number }

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })
const models = await groq.models.list()
for (const m of models.data as GroqModel[]) {
  if (m.active) console.log(m.id, "| ctx:", m.context_window)
}
process.exit(0)
