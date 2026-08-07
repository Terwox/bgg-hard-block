# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than in a public issue.

- **Preferred:** GitHub's [private vulnerability reporting](https://github.com/terwox/bgg-hard-block/security/advisories/new)
- **Email:** terwox@gmail.com

Please include what the issue lets an attacker do, the steps to reproduce it,
and the extension version. This is a hobby project maintained by one person, so
expect an initial response within about a week rather than within hours.

## Scope

This extension's threat model is narrow, so it helps to be explicit about what
counts.

### In scope

- Anything that causes the captured `GeekAuth` authorization header to leave
  page memory — written to `chrome.storage`, `localStorage`, the DOM, a log, or
  any network destination other than `api.geekdo.com`.
- Anything that causes the extension to send data to a destination other than
  `boardgamegeek.com` or `api.geekdo.com`.
- Anything that causes the extension to act before the user has granted consent
  on the onboarding page.
- Anything that lets a page other than BGG trigger the extension's privileged
  behavior — in particular, injection of the MAIN-world bridge on a non-BGG
  origin, or a crafted BGG page reaching the extension's isolated world.
- Anything that causes a subscription block to be **removed** at BGG. Linking is
  one-way by design.
- Anything that causes the extension to follow a pagination link to an origin
  other than `api.geekdo.com` (see `normalizeApiLink` in `src/page-bridge.js`).

### Out of scope

- BGG's own site behavior, markup, or API. Report those to BoardGameGeek.
- Selector breakage after a BGG frontend change. That's a normal bug — open a
  public issue.
- The fact that the MAIN-world bridge patches `window.fetch` and
  `XMLHttpRequest.prototype` on BGG pages. That is documented, intentional, and
  the mechanism by which the extension observes the auth header BGG already
  sends. See `src/page-bridge.js`.
- Findings that require the user to already have a malicious extension or
  malware installed.

## What the extension handles

Stated plainly, so you can check the claims against the source:

| Data | Where it lives | Leaves the machine? |
| --- | --- | --- |
| `GeekAuth` authorization header | MAIN-world page memory only | Only back to `api.geekdo.com`, which BGG's own frontend already sends it to |
| Blocked user IDs and usernames | `chrome.storage.local` | No |
| Profile ID→username cache | BGG-origin `localStorage`, 30-day TTL | No |
| Consent record and options | `chrome.storage.local` | No |
| Hidden post/quote counts | `chrome.storage.local` | No |
| Reply drafts | Never stored; sanitized in place | No |

There is no developer-controlled server. There is no analytics, telemetry, or
crash reporting of any kind.

## Verifying a release

If you want to confirm that the extension published on the Chrome Web Store is
built from this source, see [BUILD.md](BUILD.md).
