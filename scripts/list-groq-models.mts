import "dotenv/config"
import Groq from "groq-sdk"

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })
const models = await groq.models.list()
for (const m of models.data) {
  if (m.active) console.log(m.id, "| ctx:", m.context_window)
}
process.exit(0)
