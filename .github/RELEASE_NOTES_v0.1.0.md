# PrivacyJanitor v0.1.0 — first public release

Find your personal data on people-search sites — and make it disappear.

PrivacyJanitor scans data brokers for your listings, ranks your exposure, and automates the **official opt-out flows** through [Solari](https://getsolari.com) stealth browsers — with screenshot and session-replay evidence for every action. Local-first and free, against Incogni's $30/mo.

## Highlights

- 🔍 **Live-verified broker scans** — Whitepages, Spokeo, and FastPeopleSearch, all of which 403 plain HTTP clients and throw Cloudflare walls at real browsers. Every search runs in a stealth Chromium with a sticky US residential proxy and auto captcha solving.
- 🙋 **Namesake protection** — fact-based URL filters + fuzzy name matching, then *you* confirm every listing before anything happens.
- 📊 **PII-redacted exposure scoring** — an LLM (Groq) ranks your listings 0–100 by risk. It only ever sees tokenized placeholders like `[NAME_1]`, `[ADDR_1]`. See `src/scoring/redact.ts`.
- ✋ **Hard approval gate** — the agent fills each opt-out form, screenshots it, and waits. Nothing is submitted to any broker without your explicit click.
- 🧾 **Evidence everywhere** — screenshots on disk + a Solari session replay URL for the scan, the submit, and the email-confirmation click.
- 🗄️ **Multi-profile, 100% local** — manage several people (self, family with consent), each with profile-scoped data. Deletion is a single SQLite transaction and wipes local evidence. `node:sqlite`, zero native deps, no accounts, no telemetry.
- 🧪 **Two smoke suites** — adapter integrity + store transactions/cleanup jail (`npm run smoke` / `npm run smoke:store`).

## Verified in the wild

The author's own personal data was found on all three brokers with this release and removed through the tool — every opt-out submitted through the approval gate, each removal backed by a recorded session replay.

## Quickstart

```bash
git clone https://github.com/EzraStone/privacy-janitor.git
cd privacy-janitor
npm install
cp .env.example .env   # add SOLARI_API_KEY (required), GROQ_API_KEY (optional)
npm run dev            # http://localhost:3000
```

## Known limitations

- Broker DOMs drift; adapters use layered selector fallbacks and the smoke suite catches breakage, but a drifted flow may need a selector fix (`src/adapters/`).
- Scans take ~3–6 minutes (stealth sessions are deliberate, not instant).
- US brokers only in v0.1. Adding one = implementing the `BrokerAdapter` interface — PRs welcome.

**Full docs & privacy model:** [README](https://github.com/EzraStone/privacy-janitor#readme)
