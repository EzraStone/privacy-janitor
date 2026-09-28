# Architecture

PrivacyJanitor is a single-user Next.js app on loopback. The dashboard talks only to its
own API; the API drives broker sites through recorded Solari cloud browsers and keeps
everything it learns in a local SQLite database and evidence folder.

## Where things live

| Path | Responsibility |
|------|----------------|
| `src/app/page.tsx`, `setup-panel.tsx` | The dashboard: one client component that reads `/api/state` and posts actions. |
| `src/app/api/` | Local API. `state` (read everything; profiles, scans, decisions), `actions` (opt-outs, scoring), `evidence` (screenshots), `export` (records download), `setup` (diagnostics). `_lib.ts` parses bodies and maps errors to statuses. |
| `src/engine/orchestrator.ts` | Scans: one broker at a time, checkpointed per broker so an interrupted scan resumes. |
| `src/engine/optouts.ts`, `submission-state.ts` | Removal requests: prepare, approve, submit, confirm, as a guarded state machine. |
| `src/engine/solari.ts` | Browser sessions: stealth recipe, sticky proxy labels, per-session evidence folders, guaranteed close. |
| `src/engine/cleanup.ts` | Deleting evidence, jailed to the evidence folder. |
| `src/engine/match-hints.ts`, `export.ts` | Review-card hints; the records export. |
| `src/adapters/` | One adapter per broker, plus `helpers.ts`: result classification, extraction validators, receipts, match explanation. |
| `src/store/index.ts` | SQLite schema, migrations and every transaction. The only module that touches the database. |
| `src/scoring/` | Optional Groq ranking: redaction to tokens, the request, parsing the untrusted reply, and `report.ts`, which reads a report against current listings in the browser. |
| `src/security/requests.ts` | Loopback and same-origin checks; the confirmation-link allowlist. |
| `src/config/` | Data paths (`PJ_DATA_DIR`) and setup status. |
| `src/errors.ts` | Expected failures with their HTTP status (400, 404, 409, 503). |
| `src/types.ts` | Domain types shared by all of the above. |

## A scan

1. `POST /api/state {action: "scan"}` checks setup, then `startScan` creates the profile's
   one unfinished run (a unique index enforces one) and schedules it.
2. For each broker, `withBrokerSession` opens a recorded browser; the adapter searches,
   captures the results page, and visits up to five candidate profiles.
3. `classifyBrokerScan` turns what the adapter saw into `found`, `clear` or
   `inconclusive`. Only an explicit, visible no-results state is `clear`; challenges,
   pagination, unfamiliar pages and failed profiles are `inconclusive`.
4. `recordBrokerScanObservation` merges listings by canonical URL and checkpoints the
   broker's result in one transaction, before the browser closes. On a rescan, only a
   `clear` result can mark an earlier listing absent, and that is what verifies a removal.

## A removal request

Each attempt moves only along these transitions (`submission-state.ts`):

| From | To | When |
|------|----|------|
| `prepared` | `approved`, `cancelled` | The person approves the preview, or cancels. |
| `approved` | `submitting`, `failed`, `cancelled` | The worker claims the click; a check fails before any click; cancelled while queued. |
| `submitting` | `submitted`, `awaiting_email`, `attention_required` | A recognized receipt; the broker wants email confirmation; interrupted with the outcome unknown. |
| `awaiting_email` | `confirming`, `cancelled` | The person pastes the link, or closes the attempt. |
| `confirming` | `confirmed`, `attention_required` | A recognized confirmation, or an interruption. |
| `submitted`, `confirmed` | `removed`, `failed` | A rescan finds the listing gone, or still sees it and the person reopens the request. |
| `attention_required` | `approved`, `confirming`, `cancelled` | An acknowledged retry of the submit or the confirmation, or closing it locally. |

- **Prepare** fills the broker's form up to, never including, the final submit, and saves a
  preview screenshot. The profile and listing are fingerprinted; any change afterwards
  voids the preview.
- **Approve** is the person's consent. The worker re-checks the fingerprint, then claims the
  attempt with a compare-and-set before clicking Submit, so a duplicate approval cannot click
  twice.
- A broker click cannot be made exactly-once. If the app stops or the connection drops after
  a claim, the attempt becomes `attention_required` and is never retried automatically.
- A request the broker ignored (a rescan still sees the listing) can be reopened as `failed`,
  which allows a fresh attempt.

## Invariants worth keeping

- Nothing is ever inferred as removed from an ambiguous page.
- One active attempt per listing and one unfinished scan per profile, enforced by unique
  indexes, not just application code.
- Receipts must match recognized broker wording; unknown responses require review.
- Confirmation links may only open HTTPS pages on the listing's own broker domain.
- Evidence is only ever read or deleted inside the evidence folder, comparing physical paths.
- The API answers only loopback, same-origin requests; the page may not be framed and may
  only talk to this app.
- Values sent to Groq are tokenized first, and restored only on this machine.

## Tests

`npm run check` runs every offline suite; see [`scripts/README.md`](../scripts/README.md).
Broker adapters are tested against synthetic page fixtures, which cannot detect changes to
live sites.
