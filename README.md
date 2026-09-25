<div align="center">

# 🧹 PrivacyJanitor

### Find your listings. Review your exposure. Take control of removal requests.

An open-source, local-first workspace for official data-broker opt-outs.
Review matches and approve each request, with screenshots and a recoverable action history.

![License: MIT](https://img.shields.io/badge/License-MIT-ffffff.svg?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg?style=flat-square&logo=typescript&logoColor=white)
![Next.js 16](https://img.shields.io/badge/Next.js-16-000000.svg?style=flat-square&logo=nextdotjs)
![Status: early access](https://img.shields.io/badge/status-early%20access-71717a.svg?style=flat-square)

</div>

> [!IMPORTANT]
> **Local storage does not mean local-only processing.** Searches and form previews send
> entered details through [Solari](https://getsolari.com) cloud browsers to broker sites.
> Removal requests require your approval. Optional scoring sends tokenized data to Groq.
> Provider accounts and usage charges may apply; removal is not guaranteed.

## See it running

The walkthrough and screenshots below use the fictional profile **Jordan Example**. No real
user data, live broker results, or live submissions are included in these repository assets.

[![Watch the PrivacyJanitor feature walkthrough](docs/images/dashboard-demo.png)](docs/demo/privacy-janitor-demo.mp4)

<p align="center"><a href="docs/demo/privacy-janitor-demo.mp4"><strong>▶ Watch the 33-second feature walkthrough</strong></a><br><sub>Profiles, scans, match review, risk ranking, approval gates, email confirmation, removal verification, and history.</sub></p>

![PrivacyJanitor consent-based profile form filled with fictional demo data](docs/images/profile-form-demo.png)

<p align="center"><sub><strong>Clear profile setup</strong> with explicit consent before any person is added.</sub></p>

## How it works

1. **Add a profile** — use your own details or those of someone who authorized you.
2. **Scan and review** — search the supported brokers, then confirm which listings are yours.
   A misclicked decision can go back to review until a removal request is sent.
3. **Rank exposure (optional)** — send tokenized listing fields to Groq for a suggested priority.
   The report you read shows your real values again, restored on this machine.
4. **Preview and approve** — inspect the filled form before authorizing the removal request.
5. **Confirm and recheck** — complete the broker's email step, then run a later rescan.

### Built for review, not blind automation

- **Conservative results:** blocked pages, missing selectors, pagination, and failed profiles
  stay inconclusive. Only a recognized no-results state can establish local absence.
- **Recognized receipts:** clicking Submit or opening a confirmation link is not success by
  itself. Unknown responses require review. Broker acknowledgement is not proof of removal.
- **Recoverable work:** progress and approvals persist locally. Duplicate approvals reuse one
  attempt. Interrupted broker actions require review before an explicit retry.
- **Evidence:** local screenshots and remote session identifiers help review what happened.
  Solari replay availability depends on the provider; failed runs may have incomplete evidence.
- **Profile-scoped history:** rejected matches, prior requests, absence, and relists stay
  distinguishable. Delete a profile to remove its local records and referenced screenshots;
  **Reset all** clears the entire local evidence folder, including unreferenced files.

Preparation and approved submission reuse one bounded sticky-proxy label within Solari's
configured 30-minute window. That window can expire while waiting for approval; it does not
guarantee the same IP indefinitely.

## Quickstart

Requires **Node.js 24 or newer**; Node 24 is used in CI. This is a single-user localhost app,
not a ready-to-deploy multi-user service.

```bash
git clone https://github.com/EzraStone/privacy-janitor.git
cd privacy-janitor
npm install
cp .env.example .env
# Edit .env: SOLARI_API_KEY required, GROQ_API_KEY optional
npm run doctor
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` in place of `cp`.
Open the loopback URL printed by the server (normally [localhost:3000](http://localhost:3000)).
Restart the app after changing API keys.

The setup panel and `npm run doctor` check key presence, Node compatibility, and local
folder access. They never contact providers or print keys. “Configured” does not mean
the key or provider plan has been validated. Missing configuration blocks scans but
does not prevent you from adding profiles. Use the dashboard to run scans; the old
`npm run scan` shortcut pointed to a missing file and has been removed.

| Setting | Purpose |
|---------|---------|
| `SOLARI_API_KEY` | Cloud browser access for scans and opt-outs. Get a key from the [Solari console](https://console.getsolari.com). |
| `GROQ_API_KEY` | Optional exposure scoring. Get a key from the [Groq console](https://console.groq.com). |
| `GROQ_MODEL` | Optional scoring model override. |
| `PJ_DATA_DIR` | Optional absolute folder for local data, outside this repository or synced folders. |

The application requests stealth browsing, a residential proxy, CAPTCHA support, and recording.
Your provider plan and the live broker's behavior determine what works. Having an API key alone
does not establish access to these capabilities.
If the provider rejects the requested capabilities, the app stops with setup guidance;
it does not silently open a second, less capable session.

## Broker coverage

| Broker | Implemented flow | Automated validation |
|--------|------------------|----------------------|
| Whitepages | Search, URL-first preview, submit, email confirmation | Offline behavior fixtures |
| Spokeo | Search, URL/email preview, submit, email confirmation | Offline behavior fixtures |
| FastPeopleSearch | Search, subject-request preview, submit, email confirmation | Offline behavior fixtures |

**These are implemented adapters, not a guarantee that current live flows work.**
The 87 synthetic adapter checks exercise known success, challenge, empty-result, profile-failure,
and uncertain-action states without contacting brokers. They cannot detect changes to live
websites. A consent-based live beta is still needed after these reliability changes.

The demo assets illustrate the interface with fictional data, not proof of successful removal.
No live broker requests run as part of `npm run check`.

## Privacy model

| Data or activity | Destination and limits |
|------------------|------------------------|
| Profiles, matches, requests, scan history | Local SQLite at `data/privacy-janitor.db`, or the folder set by `PJ_DATA_DIR`. Readable only by your user account on macOS and Linux; not encrypted by the app. |
| Screenshots | Local `data/evidence/`, readable only by your user account on macOS and Linux; may contain sensitive details. |
| Searches and form entry | Solari's remote browsers and the broker sites receive entered details. Preparation can transmit fields before final approval. |
| Session recordings | Requested from Solari. Provider-side storage and retention are outside the local app's control. Treat replay links as sensitive. |
| Optional Groq scoring | Known identifier and location values are replaced with tokens. Redaction reduces disclosure but is not a guarantee of anonymity. |
| Telemetry | No application analytics are configured. The supplied `dev`, `build`, and `start` scripts disable Next.js telemetry. Providers may keep their own service logs. |
| GitHub | The app has no runtime upload-to-GitHub feature. Git publication is a separate developer action; safeguards are not a universal PII guarantee. |

### Keep your data out of commits and cloud sync

- `.env`, the default `data/` folder, databases, logs, browser traces, and HAR exports are
  ignored by Git. **Never force-add them.**
- `npm run check:repo` checks the Git index for known sensitive paths and credential patterns;
  it also runs in CI. It does **not** inspect image/video contents, all possible personal
  information, or past commits. Review every staged change before pushing.
- A folder inside **OneDrive, Dropbox, or another synced location may be uploaded by that
  service**, even when Git ignores it. Set `PJ_DATA_DIR` to a private, non-synced folder if
  needed. The app does not automatically move or delete existing data when you change it.
- Local deletion does not erase provider recordings, broker records, cloud-sync copies, or
  backups. It is not secure disk erasure. Review those services separately.
- Use synthetic data in screenshots, demos, bug reports, and test fixtures. Do not attach
  real listings, replay links, confirmation links, or API keys to public issues.

## Development

```bash
npm run typecheck       # TypeScript checks
npm run smoke           # registry, scoring, redaction, proxy labels
npm run smoke:store     # temporary SQLite: migrations, rescans, deletion
npm run smoke:security  # localhost, origin, input and confirmation URL checks
npm run smoke:workflow  # synthetic broker: approval, duplicate clicks, retries, restart
npm run smoke:adapters  # real adapters against synthetic selector fixtures
npm run smoke:privacy   # repository guard and redaction regression checks
npm run smoke:setup     # configuration, storage, and unsupported-plan checks
npm run smoke:http      # built app on loopback with an isolated synthetic profile
npm run doctor          # local setup diagnostics; no provider calls
npm run check:repo      # inspect indexed paths/content, without printing key values
npm run check           # all checks plus production build
npm audit --omit=dev    # current dependency advisories
```

The other diagnostic scripts under `scripts/` may contact providers and brokers. Read them
before running; they are not part of the offline test suite and may incur charges or save
sensitive debugging output.

### Next development milestones

1. Run a small, explicitly consented live beta; document each broker's actual result and
   validation date without publishing personal evidence.
2. Improve adapters from those observations, then add brokers one at a time with fixtures.
3. Evaluate a packaged desktop release. Public hosting requires a separate authentication,
   user-isolation, secrets, retention, and security design.

## Contributing

Adapters implement `BrokerAdapter` in `src/adapters/`; the engine owns browser sessions,
evidence, and local persistence. Include synthetic fixtures for success, challenges, and
ambiguous outcomes. Run `npm run check` before submitting changes. Do not present offline
fixture coverage as live verification.

## Responsible use

Use only for yourself or someone who authorized you. Follow the broker's official process
and applicable requirements. This is not legal advice, a guaranteed removal service, or a
general-purpose people-search tool.

## License

MIT
