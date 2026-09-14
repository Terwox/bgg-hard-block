# addons.mozilla.org (AMO) listing

The Chrome Web Store copy lives in [STORE_LISTING.md](STORE_LISTING.md). This
file is the addons.mozilla.org (AMO) equivalent: the same product, the fields
the AMO Developer Hub asks for, and the reviewer notes to paste at submission.

## Publisher

- Name: Terwox
- Contact: terwox@gmail.com
- Price: free
- Ads, analytics, telemetry, or in-app purchases: none
- Mozilla account: two-factor authentication is mandatory for add-on developers

## Listing metadata

- Name: BGG Hard Block
- Slug: `bgg-hard-block` (listing URL `https://addons.mozilla.org/firefox/addon/bgg-hard-block/`)
- Add-on ID: `bgg-hard-block@terwox.github.io` — set in
  `manifest.firefox.json` as `browser_specific_settings.gecko.id` and
  **immutable after the first upload**
- Categories: Privacy & Security; Social & Communication
- License: GPL-3.0-or-later
- Language: English (United States)
- Homepage: https://github.com/terwox/bgg-hard-block
- Support site: https://github.com/terwox/bgg-hard-block/issues
- Privacy policy: https://terwox.github.io/bgg-hard-block/privacy/

### Summary

AMO caps the summary at 250 characters.

<!-- summary: 238 characters -->

Turns BoardGameGeek's soft hide into a hard block: removes posts, quotations, and forum-index names from anyone on your BGG Hidden Users list, and optionally keeps BGG's subscription blocks aligned. Runs locally; inactive until you agree.

### Description

Turn BoardGameGeek's soft hide into a hard block.

BGG's own block feature replaces a hidden user's post with a "Blocked User /
Show Anyway" placeholder and does nothing about quotations, so the person you
blocked stays visible and quotable. BGG Hard Block removes:

- native "Blocked User / Show Anyway" placeholders
- complete discussion posts or comments written by anyone on your BGG Hidden
  Users list
- quotations attributed to hidden users, while preserving the surrounding reply
- blocked quotation subtrees from the reply draft BGG creates when you click
  Quote
- blocked usernames from forum indexes and thumbs popovers, replacing them with
  Blocked
- a blocked user's custom avatar from rows on the subscriptions feed, while
  leaving the row and ordinary artwork alone

There is intentionally no "show anyway" override.

By default, it also adds Hidden Users to BGG's separate user-level subscription
blocks. You can turn that linking off in Options. The extension never removes a
subscription block already stored by BGG.

Your existing BGG controls stay available. Use BGG's native Hidden Users and
subscription-block editors whenever you want to review or change either list.

Privacy by design:

- the extension is inactive until you review its disclosure and affirmatively
  agree
- processing happens locally in your browser
- BGG authentication is used only in temporary page/background memory and is
  never stored
- data goes only to BGG/Geekdo endpoints needed for the disclosed features
- no ads, analytics, telemetry, remote code, developer server, or third-party
  sharing
- site access is revocable at any time in about:addons → BGG Hard Block →
  Permissions

There is no build step: the source you can read on GitHub is the code that runs.
BGG Hard Block is free software under GPL-3.0-or-later. It is an unofficial
project and is not affiliated with or endorsed by BoardGameGeek, LLC.

## Platform

- Firefox for desktop only. Firefox 153 or newer
  (`browser_specific_settings.gecko.strict_min_version` is `153.0`).
- Firefox for Android is **not** opted into: the manifest deliberately omits
  `gecko_android`. Do not enable the Android checkbox at submission.
- Firefox 153 is the floor because the extension binds every privileged action
  to a `documentId`, and that field reached senders, request details, injection
  targets, and injection results in 153. Extended Support Release 140 is
  therefore excluded until the next ESR rebase.

## Assets

AMO derives the listing icon from the manifest `icons` entries, so no separate
icon upload is needed.

| Asset | Caption |
| --- | --- |
| `store-assets/onboarding-1280x800.png` | The one-time disclosure. The extension reads nothing until you agree here. |
| `store-assets/options-1280x800.png` | Options: subscription linking is on by default and can be turned off. |

## Data collection

`manifest.firefox.json` declares:

```json
"data_collection_permissions": { "required": ["none"] }
```

That is truthful, not a shortcut. Mozilla's disclosure asks what the add-on
collects *and transmits to the developer or a third party*. There is no
developer-controlled server, no analytics, no telemetry, no remote code, and no
third party. Everything the extension reads stays in the browser profile, except
the requests it makes to `api.geekdo.com` — the same endpoints BGG's own frontend
calls, with the credential BGG itself already sends.

Locally stored data (all in `chrome.storage.local`, none of it transmitted to
the developer): the consent record, the subscription-linking option, blocked
public usernames and custom-avatar identifiers with result status and counts, a
blocked-profile ID-to-username cache pruned at 30 days, and subscription-linking
status. [PRIVACY.md](PRIVACY.md) is the complete map.

## Single purpose

Remove discussion content from users on the signed-in person's BGG Hidden Users
list and, when the user leaves the option enabled, keep BGG's separate
user-level subscription blocks aligned with that same list.

## Permission justifications

Firefox treats host permissions as optional and revocable. The onboarding screen
calls `permissions.request()` from the user's own click on **Agree and enable
BGG Hard Block**, and refuses to record consent if access is not granted. A user
can withdraw it later in `about:addons` → BGG Hard Block → Permissions; the
extension then stops filtering rather than working around the revocation.

### `scripting`

Attaches the same isolated local filter after BoardGameGeek enters a supported
discussion URL through an in-page route change, and performs a
sender-document-bound MAIN-world credential capture only after the background
script confirms current consent. Injection for filtering or credential capture is
limited to the disclosed discussion-page families. After a single-page route
leaves scope, a tiny local teardown function may run on the destination BGG page
only to remove the earlier installation. The extension does not request `tabs`,
`webNavigation`, or `history`.

### `storage`

Stores the consent record; the subscription-linking option; blocked public
usernames, result status, and local counts; a blocked-profile ID-to-username
cache whose entries older than 30 days are never reused and whose next
successful sync prunes stale or no-longer-current IDs; and subscription-linking
status. No draft text and no authentication value is stored. Nothing is synced
to the developer or to any destination other than the required BGG/Geekdo
endpoints.

### `webRequest`

Observes, without modifying or blocking, the existing `Authorization: GeekAuth`
header on `https://api.geekdo.com/api/*` requests that BoardGameGeek itself
issues. The listener is registered non-blocking, with the extraInfoSpec
`["requestHeaders"]` on Firefox — `"blocking"` is never requested, and
`"extraHeaders"` is Chrome-only and probed for rather than assumed. Observation
is enabled only after current consent, validated against an active supported
discussion tab, bound to the exact tab and document, held only in memory, and
discarded after five seconds if unused. No other destination or initiator is
accepted. The `webRequestBlocking` permission is not requested and the extension
cannot alter any request.

On Firefox this observed-header path is the routine source of the credential,
not an optimization. In every measured run, BoardGameGeek's authenticated
`api.geekdo.com` request fires before the MAIN-world bridge can be injected, so
the Firefox build relies on `webRequest` observation more than the Chrome build
does; the injected bridge is the rarely taken backup rather than the normal
path. Removing `webRequest` would leave the add-on unable to read the Hidden
Users list in ordinary use.

### Host access to `boardgamegeek.com` and `api.geekdo.com`

The canonical BoardGameGeek origin is required to identify authors in rendered
discussion markup, redact matching names, remove matching
posts/placeholders/quotations, sanitize BGG-generated Quote drafts, identify
supported open tabs for refresh, and attach the filter after an in-page route
change. Injection stays limited to the disclosed discussion-page families;
scope-exit teardown may run on the destination BGG page only to remove
previously installed behavior.

The canonical Geekdo API origin is required for background requests to the
Hidden Users list, public profiles, current user-level subscription blocks, and
optional additions of missing subscription blocks. No other site or network
origin is allowed.

Both are requested from the consent click and are revocable from
`about:addons`.

## Reviewer notes

*Paste the text below into the AMO reviewer-notes field. Replace the tag and
hash placeholders with the real values for the submitted build.*

---

Thank you for reviewing. This add-on reads the signed-in user's own BGG
authorization header, so here is exactly what it does and where to look.

**Source.** There is no build step: no bundler, minifier, transpiler, or source
map. The uploaded ZIP is an allowlisted subset of the tagged source, written by
`scripts/make_zip.py` from its explicit `SHIPPED_FILES` list: `LICENSE`,
`PRIVACY.md`, `README.md`, the five `icons/` files, everything in `src/`, and
the manifest. Each shipped file is a byte copy of the tagged source, with one
substitution: the archive's `manifest.json` member is a byte copy of the
repository's `manifest.firefox.json` (the checked-in `manifest.json` is the
Chrome variant, which declares a background service worker).

`SECURITY.md` and `AUDIT_RESULTS.md` are deliberately not in the archive, since
the allowlist ships only what the add-on runs. Read them in the repository at
the submitted tag:

- Repository: https://github.com/terwox/bgg-hard-block
- Tag for this submission: vX.Y.Z
- Uploaded ZIP SHA-256: <sha256>
- Threat model and handling claims:
  https://github.com/terwox/bgg-hard-block/blob/vX.Y.Z/SECURITY.md
- Independent-audit findings and fixes:
  https://github.com/terwox/bgg-hard-block/blob/vX.Y.Z/AUDIT_RESULTS.md
- Full data map: `PRIVACY.md` in the archive, also at
  https://github.com/terwox/bgg-hard-block/blob/vX.Y.Z/PRIVACY.md

**What the add-on observes, stated plainly.** BoardGameGeek's own frontend sends
an `Authorization: GeekAuth <token>` header on its `XMLHttpRequest` calls to
`https://api.geekdo.com/api/*`. The add-on observes that existing header. It
does not create it, modify it, or block the request.

- The listener is `observedAuthorization` in `src/background.js`, registered on
  `chrome.webRequest.onBeforeSendHeaders` with the filter
  `{ urls: ["https://api.geekdo.com/api/*"], types: ["xmlhttprequest"] }` and
  the extraInfoSpec `["requestHeaders"]`. It is **non-blocking**;
  `webRequestBlocking` is not among the requested permissions. Chrome's
  `extraHeaders` value is appended only when the running browser advertises it
  in `chrome.webRequest.OnBeforeSendHeadersOptions`, so on Firefox the spec is
  `["requestHeaders"]` exactly.
- Observation happens only after the user has affirmatively agreed on the
  onboarding page. Stored consent is re-read for each candidate event before the
  header is touched, and the request's origin must resolve to
  `https://boardgamegeek.com`.
- The observed value lives in a single background-script variable, bound to the
  exact tab and document that produced it, and is discarded after
  `RECENT_AUTHORIZATION_MAX_AGE_MS` (5000 ms) if unused. It is consumed once.
- The value is never written to `storage`, the DOM, a log, or a content script,
  and it is never sent anywhere except back to `https://api.geekdo.com` on the
  four enumerated requests listed in SECURITY.md. `assertAllowedApiRequest` in
  `src/background.js` validates every outbound request; redirects are refused.

**How often the fallback runs on Firefox.** Rarely. On Firefox the observed
header is the routine source of the credential: in every measured run, BGG's
authenticated `api.geekdo.com` request fires before the MAIN-world bridge can be
injected, so the Firefox build relies on `webRequest` observation more than the
Chrome build does, and the path described next is the backup rather than the
normal one.

**Fallback path.** When the header is not observed (for example, BGG cached its
network transport before the listener attached), the background script injects
`installBggBlockListBridge` from `src/page-bridge.js` into the MAIN world with
`chrome.scripting.executeScript`, targeted at one exact `documentId` that it has
already validated as the active, top-level, supported BGG document. This is why
`manifest.firefox.json` lists `src/page-bridge.js` in `background.scripts`: it is
evaluated in the event page solely so that the `installBggBlockListBridge`
function reference exists for `scripting.executeScript({ func })`, and it
installs nothing in the background context (Chrome obtains the same reference
through `importScripts` at the top of `src/background.js`). That function
wraps `fetch` and `XMLHttpRequest` on that page only, reads the same header BGG
is already sending, and returns it to the background script as the
`executeScript` result — a direct return value, not a DOM event or a page
message. The page never receives the value back, and the wrapper removes itself
when the session ends. The only cross-world DOM event in the add-on is a
data-free, nonce-bound signal that can pause optional subscription linking; it
carries no credential and no write authority.

**Why any of this is needed.** BGG's Hidden Users list is only available from an
authenticated API endpoint. Without the user's own credential, the add-on cannot
know whom to hide. It reuses the credential the browser is already sending to
that same origin rather than asking the user for a password.

**Network destinations.** `https://boardgamegeek.com` (page integration only)
and `https://api.geekdo.com` (four enumerated endpoints, documented in
SECURITY.md). There is no developer-controlled server, analytics, telemetry, or
remote code, which is why `data_collection_permissions` is `{"required":
["none"]}`.

**Testing it.** Sign in to BoardGameGeek, add a user to Hidden Users at
`/geekblock/list`, then open a forum thread containing that user's posts. The
add-on is inert until the onboarding disclosure is accepted and host access is
granted; declining either leaves it doing nothing.
