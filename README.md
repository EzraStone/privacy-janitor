# PrivacyJanitor

**Local-first, open-source data-broker removal agent.** Finds your PII on people-search sites and automates the *official* opt-out flows — driven by [Solari](https://getsolari.com) cloud stealth browsers, with screenshot and session-replay evidence for every single action.

Built for people who don't want to pay Incogni ($30/mo) or DeleteMe ($129/yr) for something they have a legal right to do for free.

## How it works

```
┌────────────┐   ┌─────────────┐   ┌──────────────┐   ┌───────────────┐
│  1. SCAN    │→ │ 2. THIS-IS-ME│→ │ 3. EXPOSURE   │→ │ 4. OPT-OUT    │
│ Solari      │   │ confirm each │   │ SCORE (LLM,  │   │ agent fills   │
│ stealth    │   │ listing —    │   │ PII-redacted │   │ form → YOU    │
│ browsers   │   │ namesakes     │   │ prompts)     │   │ approve →     │
│ search 3+  │   │ rejected      │   │ ranks risk   │   │ submit →      │
│ brokers    │   │               │   │              │   │ email confirm │
└────────────┘   └─────────────┘   └──────────────┘   └───────┬───────┘
                                                            ▼
                                                   ┌───────────────────┐
                                                   │ 5. RE-SCAN DIFF   │
                                                   │ removed ✓ relisted⚠│
                                                   └───────────────────┘
```

Every broker interaction runs inside a **recorded Solari session** — you get a screenshot before anything is submitted, and a replay link after. Nothing is ever sent to a broker without your explicit click.

## Why Solari (the honest engineering reason)

Data-broker opt-out flows are *designed* to be hostile to automation:

- Whitepages hard-blocks non-browser HTTP clients (403 to any plain fetch)
- Opt-out forms sit behind CAPTCHA walls (reCaptcha/hCaptcha/Turnstile)
- Brokers fingerprint and IP-block datacenter traffic

PrivacyJanitor runs every flow through Solari's stealth Chromium with residential proxies and automatic captcha solving — the tool literally cannot work without it. Each session is recorded, so every removal has replayable evidence.

## Privacy model (read this part)

| What | Where it lives |
|------|----------------|
| Your identity, listings, submissions | `data/privacy-janitor.db` (local SQLite) |
| Evidence screenshots | `data/evidence/` (local files) |
| Your PII in LLM prompts | **Never** — values are tokenized (`[NAME_1]`, `[ADDR_1]`) before any Groq call; see `src/scoring/redact.ts` |
| Accounts, telemetry, backend | **None.** It's a localhost web app |

## Quickstart

```bash
git clone https://github.com/EzraStone/privacy-janitor.git
cd privacy-janitor
npm install
cp .env.example .env        # add SOLARI_API_KEY (required) + GROQ_API_KEY (optional scoring)
npm run dev                 # open http://localhost:3000
```

Get a Solari key at [console.getsolari.com](https://console.getsolari.com). Get a Groq key at [console.groq.com](https://console.groq.com) (optional — only for exposure ranking).

## Broker coverage (v0.1)

| Broker | Scan | Opt-out | Email confirm | Verified |
|--------|------|---------|---------------|----------|
| Whitepages | ✅ | ✅ URL-first suppression wizard | ✅ | live 2026-08 |
| Spokeo | ✅ | ✅ optout form (url+email) | ✅ | live 2026-08 |
| FastPeopleSearch | ✅ | ✅ subject request form | ✅ | live 2026-08 |

All three brokers block the default browser with Cloudflare/bot walls — every
flow in this table was verified end-to-end through Solari **stealth** sessions
(residential proxy + auto captcha solving + session recording).

Broker DOMs drift. Adapters live in `src/adapters/` with layered selector fallbacks; `npm run smoke` catches breakage early. Adding a broker = implementing the `BrokerAdapter` interface and registering it — PRs welcome.

## Development

```bash
npm run typecheck   # strict TS, zero errors
npm run smoke       # adapter sanity checks (no API keys needed)
npm run dev         # dashboard
```

### Architecture

```
src/
├── types.ts               # domain model + BrokerAdapter interface
├── store/                 # node:sqlite (zero native deps), local only
├── engine/
│   ├── solari.ts          # stealth session recipe, evidence, replay polling
│   └── orchestrator.ts    # scan / prepare / approve / submit / confirm / rescan
├── adapters/              # one per broker + shared DOM fallback helpers
└── scoring/               # PII redaction + Groq exposure ranking
```

## Disclaimer

Use only for your own data, or with the consent of the person whose data it is. Opt-out submissions are legal requests under the relevant privacy laws (CCPA/CPRA et al.); this tool automates *official, broker-provided* removal flows — it does not bypass anything a human couldn't do with a browser.

## License

MIT
