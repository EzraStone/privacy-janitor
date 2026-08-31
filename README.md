# PrivacyJanitor

Local-first, open-source data-broker removal agent.

Finds your PII on people-search sites and automates the **official opt-out flows** — driven by Solari cloud stealth browsers, with screenshot and session-replay evidence for every action.

> Status: v0.1 under active development. Built in public.

## What it does

1. **Scan** — searches data-broker sites for your listing(s)
2. **Disambiguate** — you confirm which listings are actually you
3. **Exposure score** — an LLM ranks your listings by risk so you kill the worst first
4. **Opt-out** — the agent fills each broker's removal form, shows you a preview, and submits only after you approve
5. **Evidence** — every run is screenshotted and session-recorded (Solari replay links)
6. **Re-scan** — brokers relist; the diff report shows removed vs. relisted

## Principles

- **Local-first** — your data stays in a SQLite file on your machine. No accounts, no telemetry, no backend.
- **BYO keys** — bring your own Solari and Groq API keys.
- **Confirm-first** — nothing is ever submitted without your explicit approval of a filled-form preview.
- **Redacted AI** — the LLM sees tokenized structure (`[NAME_1]`), never your raw PII.

## Quickstart

*(coming with the v0.1 release — see the build log below)*

## Development

```bash
npm install
cp .env.example .env     # then fill in your keys
npm run dev              # dashboard on http://localhost:3000
```

## License

MIT
