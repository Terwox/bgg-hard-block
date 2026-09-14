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
  its short-lived MAIN/background synchronization path — for example, by
  entering storage, the DOM, a log, a content-script response, or any network
  destination other than `api.geekdo.com`.
- Anything that causes the extension to send data to a destination other than
  `boardgamegeek.com` or `api.geekdo.com`.
- Anything that causes the extension to act before the user has granted consent
  on the onboarding page, or after that consent or the authorized option state
  changes during synchronization.
- Anything that lets an unsupported page or stale document trigger privileged
  behavior — in particular, a MAIN-world injection not bound to the active,
  top-level, canonical BGG discussion document that requested it.
- Anything that causes a subscription block to be **removed** at BGG. Linking is
  one-way by design.
- Anything that causes the extension to follow a pagination link to an origin
  other than `api.geekdo.com` (see `normalizePaginationLink` in `src/background.js`).

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
| `GeekAuth` authorization header | Ephemeral browser request-event, MAIN-world fallback, and background-worker memory | Only back to `api.geekdo.com`, which BGG's own frontend already sends it to |
| Consent record | `chrome.storage.local`, `bggHardBlockerConsent` | No |
| Subscription-linking option | `chrome.storage.local`, `bggHardBlockerOptions` | No |
| Blocked usernames, result status, and counts | `chrome.storage.local`, `bggHardBlockerState` | No |
| Blocked profile ID→username cache | `chrome.storage.local`, `bggHardBlockerProfileCache`; entries older than 30 days are never reused, and the next successful sync prunes stale/non-current IDs | No |
| Subscription-linking status | `chrome.storage.local`, `bggHardBlockerSubscriptionState` | No |
| Reply drafts | Never stored; sanitized in place | No |

There is no developer-controlled server. There is no analytics, telemetry, or
crash reporting of any kind.

There is no declarative MAIN-world, settings, metadata, or data-bearing
`CustomEvent` bridge. After current consent, a read-only `webRequest` listener
accepts authorization only from `api.geekdo.com/api/*` requests initiated by
BoardGameGeek, after validating the active tab is on a supported discussion URL.
Stored consent is checked for each candidate event before its header is read.
Each value is bound to an exact tab/document, consumed once, and expires after
five seconds. A document-bound MAIN-world capture remains as a private fallback;
neither path exposes the value to content. The worker rechecks authorization before network
work, before every irreversible subscription addition, and before persisting or
returning public results. The worker owns and generation-orders the canonical
cached username list; content documents can report only bounded page counters,
which the worker merges without accepting usernames or synchronization
provenance. Cached content state carries an extension-owned schema marker;
unversioned state from releases whose block-list data crossed a
page-writable bridge is discarded.

One revocation-only `CustomEvent` crosses from MAIN world to an isolated relay.
Its name is bound to a random nonce for the active document, and its payload is
empty. The relay can send only the fixed revocation message and nonce; the
worker accepts it only from the matching active, top-level discussion document.
This signal can suspend optional subscription linking after a native Hidden
Users mutation starts. It cannot disclose data or authorize a request.

All extension-originated authenticated requests run in the extension's
background script — a service worker on Chrome, an event page on Firefox — not
the page-controlled realm. They omit cookies, refuse redirects, and allow only:

- `GET https://api.geekdo.com/api/userblock`
- `GET https://api.geekdo.com/api/user/{id}`
- `GET https://api.geekdo.com/api/blocks?type=user&singular=1` and validated
  pagination on that same endpoint
- `PUT https://api.geekdo.com/api/user/{id}/blocks`

Document relay and credential capture have a worker-owned five-second deadline;
FIFO waiting and trusted synchronization then share a separate 20-second
deadline. Each synchronization is limited to 6,000 requests and 16 MiB of
response data, with a 2 MiB ceiling per response, six concurrent profile reads,
5,000 Hidden Users identifiers, and 100 subscription pages. Exceeding a bound
aborts the session without persisting its result.

Page code can withhold or substitute the observed credential, causing a safe
authentication failure or selecting whatever BGG account that credential
actually represents. It cannot supply API response data, request destinations,
methods, identifiers, or bodies to the worker.

### Residual subscription-linking race

Geekdo does not expose a conditional revision token for these operations.
Immediately before each subscription addition, the worker performs a separate
`GET /api/userblock` and then an unconditional `PUT /api/user/{id}/blocks`.
Nonce-bound revocation suspends linking when the wrapper observes a native
Hidden Users mutation in the same document, but it cannot make those two API
requests atomic. A native change could occur between the final `GET` and `PUT`.
This is a residual limitation of the available Geekdo API, not a guarantee of
atomic race protection.

## Verifying a release

If you want to confirm that the extension published on the Chrome Web Store or
on addons.mozilla.org (AMO) is built from this source, see [BUILD.md](BUILD.md).
