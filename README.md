# BGG Hard Block

BGG Hard Block is a Manifest V3 Chrome extension that turns BoardGameGeek's soft forum block into a hard block.

This is an unofficial project and is not affiliated with or endorsed by BoardGameGeek, LLC.

It removes:

- BGG's `Blocked User / Show Anyway` placeholder posts
- complete posts authored by anyone on the signed-in user's BGG block list
- quotations attributed to blocked users while preserving the surrounding reply

The forum body remains hidden until the first filtering pass completes, so blocked content does not flash onscreen. A six-second CSS failsafe prevents a broken extension or changed BGG page from leaving the site permanently blank.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository folder.
5. Open or reload a BGG forum thread while signed in.

The toolbar popup reports the current block-list count and how many posts and quotations the extension removed on the latest forum page. There is intentionally no “show anyway” override.

## How it works

BGG's current frontend requests `https://api.geekdo.com/api/userblock`, which returns the signed-in user's blocked user IDs. A document-start bridge observes the `GeekAuth` request header that BGG itself adds, uses it only in memory to request the block list and public usernames, and never sends it to the isolated content script or saves it.

The isolated content script caches only blocked usernames and status counts in `chrome.storage.local`. A `MutationObserver` applies the same filter to posts loaded dynamically. Profile ID-to-name mappings are cached for 30 days in BGG's own local storage to avoid repeating every public profile request on every page.

No browsing data, block list, authentication value, or forum content is sent to a third-party server.

## Test

The test suite has no package dependencies. It uses a local headless Chromium instance to exercise the real DOM APIs used by the extension:

```bash
./scripts/test.sh
```

It covers native BGG placeholders, full blocked-author posts, blocked quotations inside allowed replies, username normalization, authenticated API bridging, credential non-disclosure, page reveal behavior, and status storage.

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

The implementation was checked against BGG's live Angular forum markup on August 4, 2026:

- posts are wrapped in `gg-post` with an `article.post`
- native blocked posts render `Blocked User` and `Show Anyway`
- quotations use `gg-markup-quote` and `.user-attribution`
- the authenticated block-list endpoint returns numeric user IDs
- `/api/user/{id}` returns the corresponding public username

If BGG changes those contracts, native placeholder removal is likely to remain the most resilient behavior, while quote attribution or block-list synchronization may require selector/API updates.
