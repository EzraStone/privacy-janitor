# Scripts

Two kinds of script live here. **Offline suites** use temporary folders and synthetic
data, contact no provider or broker, and are what `npm run check` runs. **Live
diagnostics** open real Solari browser sessions or call Groq. They can incur charges and
send the details they use to those services and to broker sites. Read one before running it.

## Offline: safe to run any time

| Script | npm script | Checks |
|--------|-----------|--------|
| `smoke.mts` | `smoke` | Adapter registry, match hints, extraction validators, scoring parser, redaction, proxy labels |
| `smoke-store.mts` | `smoke:store` | SQLite migrations, rescans, deletion, evidence cleanup, session teardown |
| `smoke-security.mts` | `smoke:security` | Loopback and origin checks, input limits, confirmation-link allowlist |
| `smoke-workflow.mts` | `smoke:workflow` | Approval, duplicate clicks, retries and restarts, against a synthetic broker |
| `smoke-adapters.mts` | `smoke:adapters` | The real adapters against synthetic page fixtures |
| `smoke-privacy.mts` | `smoke:privacy` | Repository guard, diagnostic output location, age minimization |
| `smoke-setup.mts` | `smoke:setup` | Setup status, storage probe, synced-folder detection, doctor output |
| `smoke-http.mts` | `smoke:http` | The built app on loopback: API statuses, headers, evidence jail, export |
| `smoke-ui.mts` | `smoke:ui` | The dashboard in Chromium: flows, WCAG 2.1 AA, CSP, phone width |
| `check-repo-data.mts` | `check:repo` | Sensitive paths and key patterns in the Git index |
| `doctor.mts` via `run-doctor.mjs` | `doctor` | Local setup; prints no key values |
| `run-next.mjs` | `dev`, `build`, `start` | Starts Next.js with telemetry disabled |

## Live: providers, brokers, or your running app

| Script | Contacts | Notes |
|--------|----------|-------|
| `verify-solari.mts` | Solari, Whitepages | Proves the session recipe loads a broker; saves a screenshot to local evidence |
| `probe-plan.mts` | Solari | Which capabilities your plan allows |
| `debug-session.mts` | Solari | Minimal recorded session |
| `dump-inputs.mts`, `diag-profiles.mts`, `diag-spokeo.mts`, `diag-spokeo-city.mts`, `debug-brokers.mts` | Solari, brokers | Dump live page structure to write or fix selectors |
| `diag-wp-optout.mts`, `diag-fps-optout.mts` | Solari, brokers | Dump opt-out form structure; never submit |
| `diag-optout-prep.mts` | Solari, Spokeo | Fills an opt-out form with a synthetic listing and stops before submitting |
| `e2e-test.mts` | Solari, brokers | A full scan through the real orchestrator; saves its test profile to your local data unless `PJ_DATA_DIR` points elsewhere |
| `verify-groq.mts`, `list-groq-models.mts` | Groq | Scoring with synthetic listings; available models |
| `verify-profiles.mjs` | Your running app | Adds, edits and deletes a temporary profile **in your real local data** |

Diagnostics that save pages or screenshots write under the evidence folder, which honors
`PJ_DATA_DIR`; `smoke:privacy` enforces that. What they save can include the real details
of whoever you searched for; delete it when done, and never attach it to an issue.
