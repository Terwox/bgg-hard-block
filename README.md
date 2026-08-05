# BGG Hard Block

BGG Hard Block is a Manifest V3 Chrome extension that turns BoardGameGeek's soft block into a hard block on discussion pages.

This is an unofficial project and is not affiliated with or endorsed by BoardGameGeek, LLC.

It removes:

- BGG's `Blocked User / Show Anyway` placeholder posts
- complete posts or comments authored by anyone on the signed-in user's BGG block list
- quotations attributed to blocked users while preserving the surrounding reply

By default, it also adds every BGG Hidden User to BGG's separate user-level
subscription block list. This is a one-way safety rule: disabling the option stops
future linking, but does not delete subscription blocks already stored by BGG.

On first install, the extension opens a one-time privacy disclosure. It does not
read or filter BGG data until the user affirmatively agrees. A changed disclosure
version disables processing until the user reviews and accepts the new version.
When consent is granted or an enabled extension update is installed, the
extension automatically hard-refreshes every open supported BGG discussion tab
so the current content scripts attach immediately.

The extension's page code runs only on canonical HTTPS URLs for forum threads,
GeekLists, images, videos, files, and individual blog posts. It does not inject on
BGG's home page, game pages, collection, store, account pages, forum indexes, or
any other site. Chrome represents host permissions at the origin level and ignores
their path component, so the extension details UI still names BoardGameGeek as a
site even though content-script injection is path-limited. The single canonical
BGG host permission lets the background worker find only supported discussion tabs
for the automatic refresh; the extension does not request Chrome's broad
browsing-history access.

The discussion page remains hidden until the first filtering pass completes, so blocked content does not flash onscreen. Live synchronization can reveal it immediately; otherwise it is revealed no later than 500 ms after `DOMContentLoaded`. After that ceiling, the extension watches each lazy-loaded post and quotation in place. A semantic CSS guard suppresses BGG's native blocked placeholder immediately, while the mutation filter rechecks the owning post or quotation as its text, links, and attributes arrive. A two-second CSS failsafe prevents broken JavaScript or changed BGG markup from leaving the site permanently blank.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository folder.
5. Review the disclosure and choose **Agree and enable BGG Hard Block**.
6. Open a supported BGG discussion page while signed in. Any supported tabs
   already open when you grant consent are refreshed automatically.

The toolbar popup reports the current block-list count, subscription-link status,
and how many posts and quotations the extension removed on the latest discussion page.
There is intentionally no “show anyway” override.

Open the extension's **Options** page to disable subscription linking. BGG's own
Hidden Users editor remains available at
[`/geekblock/list`](https://boardgamegeek.com/geekblock/list); the extension links
to it but does not hide or replace it. BGG's separate subscription blocks are at
[`/subscriptions/blocks?feedType=user`](https://boardgamegeek.com/subscriptions/blocks?feedType=user).

## How it works

BGG's current frontend requests `https://api.geekdo.com/api/userblock`, which returns the signed-in user's blocked user IDs. A document-start bridge observes the `GeekAuth` request header that BGG itself adds, uses it only in memory to request the block list and public usernames, and never sends it to the isolated content script or saves it.

The isolated content script caches only the consent record, blocked usernames, the
subscription-linking option, and status counts in `chrome.storage.local`. A `MutationObserver` applies
the same filter to posts loaded dynamically. Profile ID-to-name mappings are cached
for 30 days in BGG's own local storage to avoid repeating every public profile
request on every page.

When subscription linking is enabled, the bridge reads BGG's current user-level
subscription blocks and sends BGG a `PUT` only for hidden user IDs that are missing.
It never removes a subscription block.

No browsing data, block list, authentication value, or discussion content is sent to a third-party server.

## Test

The test suite has no package dependencies. It uses a local headless Chromium instance to exercise the real DOM APIs used by the extension:

```bash
./scripts/test.sh
```

It covers native BGG placeholders, full blocked-author posts, blocked quotations
inside allowed replies, username normalization, authenticated API bridging,
credential non-disclosure, pre-consent inactivity, affirmative onboarding,
consent-triggered discussion-tab refresh, path-limited manifest scope, default-on
and opt-out subscription linking,
page reveal behavior, lazy post and quotation assembly, and status storage.

An optional networked smoke test loads the unpacked extension into a disposable Chromium profile, seeds a temporary test username, and verifies post and quote removal against a live BGG thread. If BGG gives headless Chromium a Cloudflare challenge, the test keeps the real extension loaded on the BGG origin and substitutes the live markup shape captured during development:

```bash
python3 scripts/live_smoke.py --chrome /path/to/chrome
```

## Package

```bash
./scripts/package.sh
```

The release ZIP is written to `artifacts/` and excludes tests and development files.

## Current BGG assumptions

The implementation was checked against BGG's live Angular discussion markup on August 5, 2026:

- posts are wrapped in `gg-post` with an `article.post`
- native blocked posts render `Blocked User`, `Show Anyway`, and an
  `ngbtooltip` marker describing blocked content
- quotations use `gg-markup-quote` and `.user-attribution`
- forum threads, GeekLists, images, videos, files, and blog-post comments use the
  shared `gg-comments`/`gg-post` component family
- the authenticated block-list endpoint returns numeric user IDs
- `/api/user/{id}` returns the corresponding public username
- `/api/blocks?type=user&singular=1` returns user-level subscription blocks
- `PUT /api/user/{id}/blocks` adds a user-level subscription block

If BGG changes those contracts, native placeholder removal is likely to remain the most resilient behavior, while quote attribution or block-list synchronization may require selector/API updates.
