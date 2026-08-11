# BGG Hard Block

[![CI](https://github.com/terwox/bgg-hard-block/actions/workflows/ci.yml/badge.svg)](https://github.com/terwox/bgg-hard-block/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-BGG%20Hard%20Block-brightgreen)](https://chromewebstore.google.com/detail/bgg-hard-block/hkbnpeohgacliadddhjoddiickjnlnfl)

A Manifest V3 Chrome extension that turns BoardGameGeek's soft hide into a hard
block on discussion pages.

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
- blocked authors' names from forum indexes, replacing each with **Blocked** while
  preserving the thread listing

There is intentionally no "show anyway" override.

This is an unofficial project and is not affiliated with or endorsed by
BoardGameGeek, LLC.

## Install

**From the Chrome Web Store:** [BGG Hard Block](https://chromewebstore.google.com/detail/bgg-hard-block/hkbnpeohgacliadddhjoddiickjnlnfl)

**From source:**

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Choose **Load unpacked** and select the repository folder
5. Review the disclosure and choose **Agree and enable BGG Hard Block**
6. Open a supported BGG discussion page while signed in

Any supported tabs already open when you grant consent are refreshed
automatically.

## Auditing this extension

This extension reads your BoardGameGeek session's authenticated block list. You
should not take that on trust, and you don't have to.

**There is no build step.** No bundler, no minifier, no transpiler. The files in
`src/` are the files that run in your browser, which means you can diff the
extension Chrome installed against this repository directly. [BUILD.md](BUILD.md)
walks through that, including reproducing the exact published ZIP byte-for-byte.

If you'd rather just read the code, these are the five questions worth asking and
where each is answered:

| Question | Where |
| --- | --- |
| Does it phone home? | [`src/page-bridge.js`](src/page-bridge.js) — all requests go through `fetchApi`, and `API_ROOT` is the only base URL |
| What happens to my auth header? | [`src/page-bridge.js`](src/page-bridge.js), `captureAuthorization` — module-local, never published |
| What is stored? | [`src/content.js`](src/content.js), `writeStatus` — the complete set of persisted keys |
| Can it act before I consent? | [`src/content.js`](src/content.js) consent gate, [`src/settings-bridge.js`](src/settings-bridge.js) `hasCurrentConsent` |
| Where can it run at all? | [`manifest.json`](manifest.json) `content_scripts[].matches`, and `isDiscussionUrl` in [`src/background.js`](src/background.js) |

Every source file opens with a comment explaining its role and the reasoning
behind anything non-obvious. [SECURITY.md](SECURITY.md) states the threat model
and what is in and out of scope.

## Privacy

No browsing data, block list, authentication value, or discussion content is
sent to any third-party server. There is no developer-controlled server, no
analytics, no telemetry, and no remote code.

On first install the extension opens a one-time privacy disclosure. It does not
read or filter BGG data until you affirmatively agree. If the disclosure text
changes in a later version, processing stops until you review and accept the new
version.

| Data | Where it lives | Leaves your machine? |
| --- | --- | --- |
| `GeekAuth` authorization header | page memory only | only back to `api.geekdo.com`, where BGG already sends it |
| Blocked user IDs and usernames | `chrome.storage.local` | no |
| Profile ID→username cache | BGG-origin `localStorage`, 30-day TTL | no |
| Consent record and options | `chrome.storage.local` | no |
| Hidden post/quote and redacted-name counts | `chrome.storage.local` | no |
| Reply drafts | never stored; sanitized in place | no |

Full disclosure text: [PRIVACY.md](PRIVACY.md).

## Where it runs

Filtering and BGG-data code runs only on canonical HTTPS URLs for forum indexes,
forum threads, GeekLists, images, videos, files, and individual blog posts. It
does not inject on BGG's home page, game pages, collection, store, account pages,
or any other site.

If BGG enters a supported discussion through an in-page route change, the
background worker injects that same discussion-only code at the new URL; this
covers routes that do not create a new document for Chrome's declarative path
matching.

Chrome represents host permissions at the origin level and ignores their path
component, so the extension details UI still names BoardGameGeek as a site even
though content-script injection is path-limited. The extension uses Chrome's
warning-free `scripting` permission for that attachment and does **not** request
`tabs` or `webNavigation`, which would expose broad browsing-history access.

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

BGG's frontend requests `https://api.geekdo.com/api/userblock`, which returns the
signed-in user's blocked user IDs. A document-start bridge running in the page's
own JavaScript context observes the `GeekAuth` request header that BGG itself
adds, uses it only in memory to request the block list and public usernames, and
never sends it to the isolated content script or saves it.

The isolated content script caches only the consent record, blocked usernames,
the subscription-linking option, and status counts in `chrome.storage.local`. A
`MutationObserver` applies the same filter to posts and thread listings loaded
dynamically. On forum indexes, blocked thread-author and latest-reply profile
links and their avatar-popup triggers become plain **Blocked** labels with no
profile card on hover; thread titles, dates, statistics, and navigation remain
intact. Profile ID-to-name mappings are cached for 30 days in
BGG's own local storage to avoid repeating every public profile request on every
page.

The discussion page stays hidden until the first filtering pass completes, so
blocked content does not flash onscreen. Live synchronization reveals it
immediately; otherwise it is revealed no later than 500 ms after
`DOMContentLoaded`. After that initial reveal, each newly inserted post,
quotation, and forum-list profile link remains invisible until its author is
known and allowed; ordinarily the mutation filter releases safe content before
the next frame. Progressively
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

When subscription linking is enabled, the bridge reads BGG's current user-level
subscription blocks and sends BGG a `PUT` only for hidden user IDs that are
missing. It never removes a subscription block.

## Development

```bash
./scripts/test.sh      # full check suite; needs Chrome or Chromium
./scripts/package.sh   # build the store ZIP into artifacts/
```

The test suite has no package dependencies and drives real DOM APIs in headless
Chromium rather than mocking them, because most of the risk here is whether the
selectors match BGG's actual markup. It covers native BGG placeholders, full
blocked-author posts, blocked quotations inside allowed replies, username
normalization, authenticated API bridging, credential non-disclosure,
pre-consent inactivity, affirmative onboarding, consent-triggered discussion-tab
refresh, path-limited manifest scope, in-page discussion-route injection,
default-on and opt-out subscription linking, page reveal behavior, lazy post and
quotation insertion after the initial reveal, forum-index name redaction,
progressive hydration, per-item paint quarantine, full-sweep recovery,
quote-composer sanitization, and status storage.

An optional networked smoke test loads the unpacked extension into a disposable
Chromium profile, seeds a temporary test username, and verifies post and quote
removal against a live BGG thread:

```bash
python3 scripts/live_smoke.py --chrome /path/to/chrome
```

If BGG gives headless Chromium a Cloudflare challenge, the test keeps the real
extension loaded on the BGG origin and substitutes the live markup shape
captured during development.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request — the
project's scope is deliberately narrow, and new permissions or network
destinations are out of bounds.

## Current BGG assumptions

The implementation was checked against BGG's live Angular discussion markup on
August 10, 2026:

- posts are wrapped in `gg-post` with an `article.post`
- native blocked posts render `Blocked User`, `Show Anyway`, and an
  `ngbtooltip` marker describing blocked content
- quotations use `gg-markup-quote` and `.user-attribution`
- the **Quote** button inserts nested `[q="username"]...[/q]` markup into
  `textarea.post-textarea[name="text"]`
- forum indexes render each row as `gg-thread-listing` and expose thread-author
  and latest-reply names through `/profile/<username>` links
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

## License

[GPL-3.0-or-later](LICENSE).

Copyleft is deliberate here. Anyone may fork this, but a distributed fork must
ship its source under the same terms — so a repackaged version with tracking
bolted on cannot stay closed.
