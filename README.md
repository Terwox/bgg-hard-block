# BGG Hard Block

[![CI](https://github.com/terwox/bgg-hard-block/actions/workflows/ci.yml/badge.svg)](https://github.com/terwox/bgg-hard-block/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-BGG%20Hard%20Block-brightgreen)](https://chromewebstore.google.com/detail/bgg-hard-block/hkbnpeohgacliadddhjoddiickjnlnfl)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox%20Add--ons-listing%20pending-lightgrey)](https://addons.mozilla.org/firefox/addon/bgg-hard-block/)

A Manifest V3 (MV3) extension for Chrome and Firefox that turns BoardGameGeek's
soft hide into a hard block on discussion pages.

BGG's own block feature replaces a hidden user's post with a **Blocked User /
Show Anyway** placeholder, and does nothing about quotations. If someone is
genuinely making the site unpleasant for you, a permanent reminder of their
presence plus their words quoted verbatim in other people's replies is not much
of a block.

This extension removes:

- BGG's `Blocked User / Show Anyway` placeholder posts
- complete posts or comments authored by anyone on your BGG Hidden Users list
- quotations attributed to blocked users, while preserving the surrounding reply
- blocked quotation subtrees from the reply draft BGG creates when you click **Quote**
- blocked authors' names from forum indexes and thumbs popovers, replacing each
  with **Blocked** while preserving the surrounding listing

There is intentionally no "show anyway" override.

This is an unofficial project and is not affiliated with or endorsed by
BoardGameGeek, LLC.

## Install

### Chrome

**From the Chrome Web Store:** [BGG Hard Block](https://chromewebstore.google.com/detail/bgg-hard-block/hkbnpeohgacliadddhjoddiickjnlnfl)

**From source:**

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Choose **Load unpacked** and select the repository folder
5. Review the disclosure and choose **Agree and enable BGG Hard Block**
6. Open a supported BGG discussion page while signed in

### Firefox

Firefox 153 or newer, desktop only.

**From addons.mozilla.org (AMO):** not published yet. The listing at
[addons.mozilla.org/firefox/addon/bgg-hard-block](https://addons.mozilla.org/firefox/addon/bgg-hard-block/)
returns 404 until AMO review completes.

**From source, temporarily:**

1. Clone this repository
2. Build the Firefox archive with `./scripts/package.sh` (on Windows, without
   bash: `python scripts/make_zip.py . artifacts/bgg-hard-block-<version>-firefox.zip --firefox`)
3. Open `about:debugging#/runtime/this-firefox`
4. Choose **Load Temporary Add-on** and pick
   `artifacts/bgg-hard-block-<version>-firefox.zip`; the file picker accepts a
   `.zip` or `.xpi` archive as well as a manifest
5. Review the disclosure, choose **Agree and enable BGG Hard Block**, and grant
   site access when Firefox asks
6. Open a supported BGG discussion page while signed in

Load the archive rather than the repository folder, because Firefox always reads
`manifest.json` from the add-on root and the repository's `manifest.json` is the
Chrome one — `manifest.firefox.json` is swapped in under the `manifest.json`
name only inside the Firefox package. A temporary add-on is discarded when
Firefox restarts, so repeat these steps each session.

Firefox treats host permissions as revocable. You can review or withdraw the
extension's access to `boardgamegeek.com` and `api.geekdo.com` at any time under
`about:addons` → **BGG Hard Block** → **Permissions**. The consent screen asks
for that access when you agree, and does not record consent without it.

Any supported tabs already open when you grant consent are refreshed
automatically.

## Auditing this extension

This extension reads your BoardGameGeek session's authenticated block list. You
should not take that on trust, and you don't have to.

**There is no build step.** No bundler, no minifier, no transpiler. The files in
`src/` are the files that run in your browser, which means you can diff the
extension your browser installed against this repository directly.
[BUILD.md](BUILD.md) walks through that for Chrome and for Firefox, including
reproducing the exact published ZIP byte-for-byte.

If you'd rather just read the code, these are the five questions worth asking and
where each is answered:

| Question | Where |
| --- | --- |
| Does it phone home? | [`src/background.js`](src/background.js), `fetchApi` and `assertAllowedApiRequest` — the worker constructs and validates every request |
| What happens to my auth header? | [`src/background.js`](src/background.js), `observedAuthorization` and `runBridgeSession`, plus the document-bound fallback in [`src/page-bridge.js`](src/page-bridge.js) — private, ephemeral, and never stored or sent to content |
| What is stored? | [PRIVACY.md](PRIVACY.md) has the complete map; writes are in `src/onboarding.js`, `src/options.js`, and [`src/background.js`](src/background.js). `src/content.js` can report only bounded page counters to the worker. |
| Can it act before I consent? | [`src/content.js`](src/content.js) consent gate and [`src/background.js`](src/background.js), `initializeBridge` |
| Where can it run at all? | [`manifest.json`](manifest.json) (and `manifest.firefox.json`, which declares the identical scope) `content_scripts[].matches`, and `isDiscussionUrl` in [`src/background.js`](src/background.js) |

Every source file opens with a comment explaining its role and the reasoning
behind anything non-obvious. [SECURITY.md](SECURITY.md) states the threat model
and what is in and out of scope. [AUDIT_RESULTS.md](AUDIT_RESULTS.md) maps the
v0.4.0 audit recommendations to verified fixes, measurements, and remaining
hypotheses.

## Privacy

No browsing data, block list, authentication value, or discussion content is
sent to Terwox or to any server other than the BGG/Geekdo endpoints required for
the disclosed features. There is no developer-controlled server, analytics,
telemetry, or remote code.

On first install the extension opens a one-time privacy disclosure. It does not
read or filter BGG data until you affirmatively agree. If the disclosure text
changes in a later version, processing stops until you review and accept the new
version.

| Data | Where it lives | Leaves your machine? |
| --- | --- | --- |
| `GeekAuth` authorization header | ephemeral browser request-event, MAIN-world fallback, and background-worker memory | only back to `api.geekdo.com`, where BGG already sends it |
| Consent record and subscription-linking option | `chrome.storage.local` | no |
| Blocked usernames, custom-avatar identifiers, result status, and counts | `chrome.storage.local` | no |
| Profile ID→username/custom-avatar cache | `chrome.storage.local`; entries older than 30 days are never reused and the next successful sync prunes stale/non-current IDs | no |
| Subscription-linking status | `chrome.storage.local` | no |
| Reply drafts | never stored; sanitized in place | no |

Full disclosure text: [PRIVACY.md](PRIVACY.md).

## Where it runs

Filtering and BGG-data code runs only on canonical HTTPS URLs for forum indexes,
forum threads, GeekLists, images, videos, files, individual blog posts, and the
subscriptions feed. It
does not activate filtering or credential capture on BGG's home page, game pages,
collection, store, account pages, or any other site. After a single-page route
leaves a supported page, a tiny local teardown function may run on the destination
BGG page only to remove previously installed behavior; it reads no page data and
makes no network request.

If BGG enters a supported page through an in-page route change, the
background worker injects that same path-limited code at the new URL; this
covers routes that do not create a new document for the browser's declarative
path matching.

Browsers represent host permissions at the origin level and ignore their path
component; Firefox additionally lets you revoke that access from `about:addons`.
The extension therefore declares the canonical BoardGameGeek origin
for path-limited integration and the canonical Geekdo API origin for
background synchronization. It uses `scripting` for document-bound attachment
and `webRequest` only to observe the existing authorization header on Geekdo API
requests initiated by an active supported BGG document. It does **not** request
`tabs`, `webNavigation`, or `history` access.

## Subscription linking

By default, the extension also adds every BGG Hidden User to BGG's separate
user-level subscription block list. This is a **one-way** rule: disabling the
option stops future linking, but does not delete subscription blocks BGG has
already stored, because the extension cannot tell which ones you set yourself.

Turn it off on the extension's **Options** page. BGG's own editors remain
available and untouched:

- Hidden Users: [`/geekblock/list`](https://boardgamegeek.com/geekblock/list)
- Subscription blocks: [`/subscriptions/blocks?feedType=user`](https://boardgamegeek.com/subscriptions/blocks?feedType=user)

## How it works

BGG's frontend requests `https://api.geekdo.com/api/userblock`. After consent,
the background worker observes the `GeekAuth` header that BGG itself adds through
the browser's read-only request event. The listener is limited to `api.geekdo.com/api/*`,
requires BGG as the initiator, validates the active tab is on a supported URL,
verifies stored consent for each observed request, and binds each
value to the exact tab and document. A short
MAIN-world bridge remains as a document-bound fallback. The value never enters
the DOM, extension storage, logs, or the isolated content script, and an unused
observation expires after five seconds.

The background worker validates the exact sending document and current consent,
receives the privately captured authorization value, then rechecks consent and
the subscription option. It constructs every Geekdo URL itself and performs the authenticated API
requests in the extension's background script — a service worker in Chrome, an
event page in Firefox — where page code cannot forge response data. Redirects and unexpected methods, paths, queries, identifiers, response
sizes, request totals, or pagination destinations are refused. Consent and options are checked
again before each subscription addition and before cache/status persistence or
the public response. The authorization reference is cleared when synchronization
settles; content receives only public usernames, custom-avatar identifiers, and status.

The MAIN-world wrapper also notices a native, non-`GET` Hidden Users request and
emits a data-free event bound to that document's random session nonce. An
isolated relay can forward only that nonce and a fixed revocation message. The
worker accepts it only from the matching active top-level document and uses it
only to pause optional subscription linking; it grants no read or write
authority. A later supported-page load retries linking from fresh
Hidden Users and subscription-block reads.

A `MutationObserver` applies the filter to posts, thread listings, thumbs
popovers, and subscription-feed images loaded dynamically. On forum indexes, blocked thread-author and
latest-reply profile links and their avatar-popup triggers become plain
**Blocked** labels with no profile card on hover; thread titles, dates,
statistics, and navigation remain intact. In a post's thumbs popover, each
blocked giver likewise becomes an inert **Blocked** label while allowed givers
remain normal profile links. On `/subscriptions`, a feed image is hidden when
its stable avatar filename matches one published by a user on the synced Hidden
Users list; ordinary thread and GeekList artwork, the row itself, and the small
item-type badge remain visible. Profile ID-to-name and custom-avatar mappings are cached in
`chrome.storage.local` for up to 30 days to avoid repeating every public profile
request on every page. Each successful synchronization retains mappings only
for IDs still on the current Hidden Users list. The obsolete BGG-origin
`localStorage` cache is removed.

The supported page stays hidden until the first filtering pass completes, so
blocked content does not flash onscreen. Live synchronization reveals it
immediately; otherwise it is revealed no later than 500 ms after
`DOMContentLoaded`. After that initial reveal, each newly inserted post,
quotation, forum-list profile link, and thumbs-list profile link remains
invisible until its author is known and allowed; ordinarily the mutation filter
releases safe content before the next frame. Progressively
hydrated content stays quarantined until its identifying text, links, or
attributes arrive. Quotes collapse rather than reserving an invisible rectangle
while quarantined. Intentionally anonymous `[q]` quotations—including BGG's
empty-header shell and explicit `Quote:` no-author forms—are released as soon as
their body is populated. BGG's semantic no-author marker is released directly
by CSS, without waiting for JavaScript, and current `@handle wrote:` attribution
is parsed correctly. A debounced full-document
pass backs up the targeted mutation checks, while a semantic CSS guard suppresses
BGG's native blocked placeholder immediately. A two-second CSS failsafe prevents
broken JavaScript or changed BGG markup from leaving the site permanently blank.

After you click BGG's **Quote** button, the content script locally parses the
nested `[q="username"]...[/q]` text BGG inserts into the reply editor. It removes
each complete blocked-user quote subtree — including quotations nested inside
that subtree — while preserving the allowed post being quoted and its reply text.
It then emits the editor's normal input event so BGG adopts the sanitized draft.
Reply drafts are never stored.

When subscription linking is enabled, the background worker reads BGG's current
user-level subscription blocks and sends BGG a `PUT` only for hidden user IDs
that are missing. It never removes a subscription block. Before each addition it
reads Hidden Users again and skips an ID that is no longer present. This is a
best-effort race check, not an atomic transaction: Geekdo exposes a separate
`GET` followed by an unconditional `PUT`, with no conditional revision token, so
a native change can still land between those requests.

## Development

```bash
python3 -m venv ../bgg-hard-block-venv
source ../bgg-hard-block-venv/bin/activate
python3 -m pip install --require-hashes -r requirements-dev.txt
./scripts/test.sh      # full check suite; needs Chrome or Chromium
./scripts/package.sh   # build both store ZIPs into artifacts/
```

`scripts/package.sh` writes the Chrome ZIP and the Firefox ZIP; see
[BUILD.md](BUILD.md). The Firefox steps in `scripts/test.sh` run when
`FIREFOX_BIN` points at a Firefox 153+ binary or the script finds one, and are
skipped otherwise. Set `CHROME_BIN` and `FIREFOX_BIN` to exercise both browsers
in a single run.

The shipped extension has no runtime dependencies. Contributors install the
hash-locked `websockets` test dependency above. The suite drives real DOM APIs
in a real headless browser rather than mocking them, because most of the risk
here is whether the selectors match BGG's actual markup. It covers native BGG placeholders, full
blocked-author posts, blocked quotations inside allowed replies, username
normalization, authenticated API bridging, credential non-disclosure,
pre-consent inactivity, affirmative onboarding, consent-triggered discussion-tab
refresh, path-limited manifest scope, in-page discussion-route injection,
default-on and opt-out subscription linking, page reveal behavior, lazy post and
quotation insertion after the initial reveal, forum-index and thumbs-list name
redaction,
progressive hydration, per-item paint quarantine, full-sweep recovery,
quote-composer sanitization, subscription-avatar matching, and status storage.

An optional networked smoke test loads the unpacked extension into a disposable,
signed-out Chromium profile, seeds a temporary cached username, and verifies
post and quote removal against a live BGG thread:

```bash
python3 scripts/live_smoke.py --chrome /path/to/chrome
```

Use Chromium or Chrome for Testing; current branded Chrome builds ignore the
command-line flag for loading unpacked extensions. If BGG gives headless
Chromium a Cloudflare challenge, the test keeps the real extension loaded on the
BGG origin and substitutes the markup shape captured during development. That
fallback verifies extension behavior, not current live-site compatibility.

The live smoke test is Chromium-only on purpose; there is no Firefox equivalent.
Automated Firefox coverage runs through `tests/consent_gate_e2e_firefox.py` and
`scripts/browser_test.py --browser firefox`, which drive Firefox over WebDriver
BiDi instead.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request — the
project's scope is deliberately narrow, and new permissions or network
destinations are out of bounds.

## v0.4.7

- Adds Firefox support: a second checked-in manifest, a Gecko event-page
  background, and Firefox test and packaging lanes. The addons.mozilla.org
  (AMO) listing is still pending; the build requires Firefox 153 or newer.
- Asks for host access from the consent screen when the browser has not already
  granted it, instead of assuming the permission is present.
- Reports in the popup when site access is turned off, so a silent extension is
  distinguishable from a broken one.
- Leaves the disclosure text and its version unchanged, so existing Chrome users
  are not re-prompted by this release.

## v0.4.6

- Versions the stored avatar profile cache and migrates stale entries, so a
  cache written by an earlier schema is discarded rather than read back.
- Bumps the content state schema alongside it.

## v0.4.5

- Fixes the subscriptions feed's private authorization bridge rejecting the
  page before avatar mappings could synchronize.
- Adds a regression check that keeps the bridge's exact page allowlist aligned
  with the manifest and isolated content script.

## v0.4.4

- Hides a blocked user's custom avatar from rows on BGG's subscriptions feed
  while retaining the row, item-type badge, and ordinary thread/GeekList art.
- Resolves stable avatar filenames from the same public BGG profiles already
  used for blocked usernames; neither image analysis nor a new network origin
  is required.
- Adds subscriptions-page scope, pre-paint quarantine for lazily hydrated feed
  images, cache migration, and runtime regression coverage.

## v0.4.3

- Fixed live filtering never syncing at all: BGG fires a second navigation-like
  `loading` event on a document that never went away, and the extension was
  invalidating that still-current document's sync. The content script now
  re-asks for a sync twice when its session is invalidated, instead of accepting
  the first refusal.
- Fixed a duplicate MAIN-world bridge entry ending the authorization capture
  before BGG's first authenticated request could arrive.
- Added regression coverage that drives the real consent and bridge paths end to
  end, rather than calling the DOM filter directly.

## v0.4.2

- Fixed a cold-worker race in v0.4.1 that could discard BGG's authorization
  header before stored consent finished loading.
- Added coverage for authorization arriving before the content bridge starts
  and for refusing the same event without current consent.

## v0.4.1

- Fixed filtering after upgrade when BGG cached its network transport before the
  0.4.0 MAIN-world bridge could attach.
- Added consent-gated, exact-document authorization observation for only BGG's
  Geekdo API requests, while retaining the existing private fallback.
- Added a regression fixture for BGG's split display-name/`@handle` quote markup.

## v0.4.0

- Moved MAIN-world injection and all consent/option authorization into the
  background trust boundary; removed the declarative MAIN-world and settings
  bridges.
- Moved authenticated API requests into the service worker so page-controlled
  network functions and responses cannot become persisted block data or writes.
- Added narrowly scoped `api.geekdo.com` host access for those worker-owned
  requests; Chrome may ask existing users to approve the permission update.
- Moved the profile ID-to-username cache from BGG `localStorage` to
  `chrome.storage.local`; entries older than 30 days are ignored, and each
  successful sync prunes stale and no-longer-current IDs.
- Rejects unversioned cached block-list state from the retired page-data bridge.
- Hardened release packaging with a tracked-file allowlist, deterministic stored
  ZIP entries, hash-locked test tooling, and Windows/Linux byte comparison in CI.

## Current BGG assumptions

The controlled fixtures encode these expected BGG Angular and API contracts.
They were not independently reverified against an authenticated live session in
the August 15, 2026 audit:

- posts are wrapped in `gg-post` with an `article.post`
- native blocked posts render `Blocked User`, `Show Anyway`, and an
  `ngbtooltip` marker describing blocked content
- quotations use `gg-markup-quote` and `.user-attribution`
- the **Quote** button inserts nested `[q="username"]...[/q]` markup into
  `textarea.post-textarea[name="text"]`
- forum indexes render each row as `gg-thread-listing` and expose thread-author
  and latest-reply names through `/profile/<username>` links
- thumbs popovers render as `gg-reactions-list-popover`, with profile links
  nested under `gg-thumbs-list` and `gg-username-link`
- forum threads, GeekLists, images, videos, files, and blog-post comments use the
  shared `gg-comments`/`gg-post` component family
- the authenticated block-list endpoint returns numeric user IDs
- `/api/user/{id}` returns the corresponding public username
- `/api/blocks?type=user&singular=1` returns user-level subscription blocks
- `PUT /api/user/{id}/blocks` adds a user-level subscription block

If BGG changes those contracts, native placeholder removal is likely to remain
the most resilient behavior, while quote attribution or block-list
synchronization may require selector or API updates. Those breaks are the most
useful thing to report — see the
[markup break issue template](.github/ISSUE_TEMPLATE/bgg-markup-break.md).

## Reporting Firefox bugs

Something that misbehaves only in Firefox goes to the
[Firefox bug template](.github/ISSUE_TEMPLATE/firefox-bug.md), which asks for the
Firefox version, whether site access is currently granted, and the Browser
Console output.

## License

[GPL-3.0-or-later](LICENSE).

Copyleft is deliberate here. Anyone may fork this, but a distributed fork must
ship its source under the same terms — so a repackaged version with tracking
bolted on cannot stay closed.
