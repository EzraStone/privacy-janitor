# Changelog

Notable changes for people using PrivacyJanitor. Broker behavior is verified only by
offline fixtures; see the README's limitations.

## Unreleased

### Added

- **Match hints** on review cards: which details agree with the profile, with name and
  city alone never read as a strong match.
- **Undo** for listing decisions until a removal request is sent.
- **Records export**: download a profile's findings, decisions, requests and scans as
  JSON ([format](docs/records-format.md)).
- **Evidence links**: each listing and each scan result links to the broker page it came
  from; approval previews open at full size.
- **Queue overview**: request dates, a summary of what needs you, what is with brokers and
  what is gone, and a to-do count on each profile.
- Requests the broker ignored can be requested again after a rescan; an attempt whose
  confirmation email never arrived can be closed.
- Setup diagnostics (`npm run doctor` and a setup panel), including a warning when local
  data sits in a OneDrive, Dropbox, iCloud Drive or Google Drive folder.
- Scans resume after an interruption, broker by broker.

### Changed

- Removal is verified conservatively: only an explicit no-results page counts as absence,
  and a broker receipt must match recognized wording.
- Brokers are shown by name, rescan changes in words, and scan history newest first.
- Exposure reports show real values again, are dated, and say when rankings no longer
  apply or listings were left unranked.
- Profile fields are validated on the server, with messages shown inside the form.

### Fixed

- Duplicate approvals and interrupted submissions can no longer send a request twice
  without an explicit, acknowledged retry.
- Scraped ages, phones, emails, addresses and relatives are checked and tidied, and
  profile extraction falls back past page chrome.
- Namesake matching compares whole names, folded accents and full relative names.
- API errors carry meaningful statuses (400, 404, 409, 503) instead of 500.
- Deleting a profile removes its evidence folders, and Reset all removes unreferenced
  evidence too.

### Security and privacy

- A full Content-Security-Policy confines the dashboard to its own origin; framing is
  blocked; powerful browser features are denied; API responses are never cached.
- The local database and evidence are owner-only on macOS and Linux.
- Values sent to optional Groq scoring are typed and tokenized by field.
- A private vulnerability reporting policy ([SECURITY.md](SECURITY.md)), and issue and
  pull request templates that keep personal data out.

### Accessibility

- WCAG 2.1 AA contrast, a visible focus ring on every control, labelled fields, announced
  errors and scan progress, and headings on every listing card, audited automatically at
  desktop and phone width.

## 0.1.0 — 2026-09-01

First public release. See the [release notes](.github/RELEASE_NOTES_v0.1.0.md), and their
correction about local processing and verification claims.
