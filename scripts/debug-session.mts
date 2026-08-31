import "dotenv/config"
import { getSolariClient, withBrokerSession } from "../src/engine/solari.ts"

console.log("test: minimal withBrokerSession run…")
try {
  const { result, evidence } = await withBrokerSession("minimal-test", async (page) => {
    console.log("page received, navigating…")
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" })
    console.log("navigated. url:", page.url())
    const title = await page.locator("h1").innerText()
    console.log("h1:", title)
    return "ok"
  })
  console.log("result:", result, "evidence:", evidence.evidenceDir)
} catch (e) {
  console.error("FAILED:", e)
}
process.exit(0)
