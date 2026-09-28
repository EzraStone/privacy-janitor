# Security policy

PrivacyJanitor handles the personal details of the people it protects, so a
security problem can expose exactly what the tool exists to remove.

## Reporting a vulnerability

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/EzraStone/privacy-janitor/security/advisories/new)
(the repository's **Security** tab). Please do not open a public issue.

Include what an attacker could do, the steps to reproduce it with synthetic data such
as the fictional profile "Jordan Example", and the commit you tested. Never send a real
person's details, listing links, screenshots, confirmation or replay links, or API keys.

You can expect an acknowledgement within a week. Fixes land on `main`; the advisory is
published once a fix is available.

## Scope

In scope: the local app and its API: loopback and origin checks, the evidence
file jail, confirmation-link validation, data deletion, the redaction applied before
optional scoring, and anything that could send local data somewhere unexpected.

Out of scope: the broker sites and the Solari and Groq services themselves; report
those to their operators. PrivacyJanitor is a single-user localhost app. Exposing it on
a network or hosting it for others is unsupported and outside its security model.
