# Records export format

**Download records** on the dashboard (or `GET /api/export?identityId=…` on the local
app) saves one profile's history as a JSON file named
`privacy-janitor-<name>-<date>.json`. It is your paper trail: what was found where, what
you decided, and every removal request and scan.

> [!WARNING]
> The file contains the profile's personal details and every broker record found for
> them. It is not encrypted. Store it like any other sensitive document, and never attach
> it to a public issue.

## Version

Every file carries `"format": "privacy-janitor-records/1"`. A change that renames or
removes a field will use a new version; new fields may be added within a version.

## Contents

| Field | Meaning |
|-------|---------|
| `format` | Format version, as above. |
| `exportedAt` | When the file was made (ISO 8601, UTC). |
| `profile` | `fullName`, `city`, `stateCode`, optional `ageRange` and `relatives`, and `createdAt`. |
| `listings[]` | One entry per broker record found for the profile. |
| `requests[]` | One entry per removal attempt, grouped by listing, newest attempt first. |
| `scans[]` | One entry per scan or rescan, newest first. |

### `listings[]`

| Field | Meaning |
|-------|---------|
| `id` | Local listing id; `requests[].listingId` and `scans[].changes[].listingId` refer to it. |
| `broker` | Broker name, such as `Spokeo`. |
| `url` | The broker's page for the record. |
| `displayName` | The name the broker shows. |
| `decision` | `yours`, `not_you`, or `undecided`. |
| `presence` | `seen`, or `absent` once a conclusive rescan no longer found it. |
| `firstSeenAt`, `lastSeenAt`, `lastAbsentAt` | When scans first saw, last saw, and last missed the record. |
| `exposedData` | What the broker showed: `addresses`, `phones`, `emails`, `relatives`, `aliases`, `age`. |

### `requests[]`

| Field | Meaning |
|-------|---------|
| `listingId`, `broker` | The listing the request was for. |
| `status` | The attempt's last state, such as `awaiting_email`, `confirmed`, `removed`, `failed` or `cancelled`. |
| `createdAt`, `updatedAt` | When the attempt started and last changed. |
| `attempts` | How many times it was sent to the broker. |
| `removedVerifiedAt` | When a rescan confirmed the record was gone, if it has. |
| `lastError` | The last problem recorded, if any. |
| `submitSessionId`, `confirmSessionId` | Recorded Solari sessions for the submission and the email confirmation. Treat them as sensitive: replays can show personal details. |

### `scans[]`

| Field | Meaning |
|-------|---------|
| `kind` | `scan` or `rescan`. |
| `startedAt`, `finishedAt` | When it ran; no `finishedAt` while running. |
| `results[]` | Per broker: `broker`, `outcome` (`found`, `clear` or `inconclusive`), `listingsFound`, and any `issue`. |
| `changes[]` | Rescan changes per listing: `new`, `still_listed`, `removed`, `still_removed`, `relisted` or `no_longer_seen`, with `at`. |

## Left out on purpose

- **Screenshots.** They stay in the local evidence folder; the file does not embed them.
- **Local file paths.** They describe this computer, not your records.
- **Pending preview state**, including the contact email typed for a request not yet sent.
