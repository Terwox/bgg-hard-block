# Chrome Web Store listing

## Publisher

- Name: Terwox
- Contact: terwox@gmail.com
- Account type: non-trader
- Price: free
- Ads, analytics, telemetry, or in-app purchases: none

## Listing metadata

- Name: BGG Hard Block
- Category: Productivity
- Language: English (United States)
- Homepage: https://terwox.github.io/bgg-hard-block/
- Support: https://terwox.github.io/bgg-hard-block/support/
- Privacy policy: https://terwox.github.io/bgg-hard-block/privacy/

## Detailed description

Turn BoardGameGeek's soft hide into a hard block.

BGG Hard Block removes:

- native “Blocked User / Show Anyway” placeholders
- complete discussion posts or comments written by anyone on your BGG Hidden Users list
- quotations attributed to hidden users, while preserving the surrounding reply
- blocked quotation subtrees from the reply draft BGG creates when you click Quote
- blocked usernames from forum indexes and thumbs popovers, replacing them with
  Blocked

By default, it also adds Hidden Users to BGG's separate user-level subscription
blocks. You can turn that linking off in Options. The extension never removes a
subscription block already stored by BGG.

Your existing BGG controls stay available. Use BGG's native Hidden Users and
subscription-block editors whenever you want to review or change either list.

Privacy by design:

- the extension is inactive until you review its disclosure and affirmatively agree
- processing happens locally in your browser
- BGG authentication is used only in temporary page/background memory and is never stored
- data goes only to BGG/Geekdo endpoints needed for the disclosed features
- no ads, analytics, telemetry, remote code, developer server, or third-party sharing

BGG Hard Block is free. It is an unofficial project and is not affiliated with or
endorsed by BoardGameGeek, LLC.

## Single purpose

Remove discussion content from users on the signed-in person's BGG Hidden Users list
and, when the user leaves the option enabled, keep BGG's separate user-level
subscription blocks aligned with that same list.

## Permission justification

### `scripting`

Attaches the same isolated local filter after BoardGameGeek enters a supported
discussion URL through an in-page route change, and performs a sender-document-
bound MAIN-world credential capture only after the background worker confirms
current consent. Injection for filtering or credential capture is limited to the seven
disclosed discussion-page families. After a single-page route leaves scope, a
tiny local teardown function may run on the destination BGG page only to remove
the earlier installation. The extension does not request Chrome's `tabs`,
`webNavigation`, or `history` permissions.

### `storage`

Stores the consent record; subscription-linking option; blocked public usernames,
result status, and local counts; a blocked-profile ID-to-username cache whose
entries older than 30 days are never reused and whose next successful sync
prunes stale/non-current IDs; and subscription-linking status. No draft text or
authentication value is stored. No data is synced to the developer or any
destination other than the required BGG/Geekdo endpoints.

### `webRequest`

Observes, without modifying or blocking, the existing `GeekAuth` header on
`https://api.geekdo.com/api/*` requests initiated by BoardGameGeek. Capture is
enabled only after current consent, validated against an active supported
discussion tab, bound to the exact tab/document, held only in memory, and expires
after five seconds if unused. No other request destination or initiator is
accepted.

### BoardGameGeek and Geekdo host access

The canonical BoardGameGeek origin is required to identify authors in rendered
discussion markup, redact matching names, remove matching posts/placeholders/
quotations, sanitize BGG-generated Quote drafts, identify supported open tabs for
refresh, and attach the filter after an in-page route change. Injection for
filtering or credential capture remains limited to the seven disclosed
discussion-page families; scope-exit teardown may run on the destination BGG
page only to remove previously installed behavior. The canonical Geekdo
API origin is required for background requests to the Hidden Users list, public
profiles, current user-level subscription blocks, and optional additions of
missing subscription blocks. No other site or network origin is allowed.

## Data disclosures

The extension handles these categories solely for its disclosed single purpose:

- personally identifiable information: BGG user identifiers and public usernames
- authentication information: the current BGG authorization value, transiently
  in MAIN-world and background-worker memory
- website content: rendered BGG discussion posts, comments, author attributions,
  and BGG-generated reply-draft text; drafts are processed locally and never retained
- web browsing activity: the active address is checked only in memory to enforce
  the seven supported BGG discussion-page families and is never retained

The extension does not collect financial, health, location, personal communication,
or advertising-profile data. Terwox receives no extension user data and no human can
review it.

There is no page-DOM block-list or settings bridge. The profile cache is stored
only in `chrome.storage.local`; version 0.4.0 removes
the obsolete BGG `localStorage` copy.

A data-free event bound to a random per-document nonce can only pause optional
linking when BGG's native Hidden Users changes. Linking retries on the next
supported discussion-page load. Geekdo provides no conditional revision token,
so the final Hidden Users `GET` and subscription-block `PUT` are separate rather
than atomic.

## Version 0.4.2 update

- Fixed the v0.4.1 cold-start race that could discard BGG authorization before
  the extension finished loading stored consent.
- Authorization candidates now verify stored consent for the request itself,
  including when the page request arrives before its content bridge.

## Version 0.4.1 update

- Fixed missing post and quote filtering when BGG initialized its network
  transport before the document-bound fallback could attach.
- Added a consent-gated, read-only request observer restricted to BGG-initiated
  Geekdo API calls and the exact active discussion document.
- Added current split display-name/`@handle` quote markup to regression coverage.

## Version 0.4.0 update

- Removed declarative MAIN-world and settings bridges in favor of background-
  authorized, sender-document-bound injection.
- Moved authenticated API requests into the service worker so page-controlled
  functions and responses cannot become persisted block data or subscription writes.
- Added required access to only `https://api.geekdo.com/*` for those worker-owned
  requests; existing users may need to approve Chrome's permission update.
- Moved the bounded profile cache behind the extension storage boundary; stale
  entries are ignored, and successful syncs prune stale/non-current IDs.
- Rejects unversioned cached block-list state from the retired page-data bridge.
- Hardened release packaging with an explicit tracked-file allowlist,
  deterministic ZIP entries, hash-locked test tooling, and Windows/Linux byte
  comparison in CI.

## Limited Use certifications

- User data is used only to provide the extension's disclosed single purpose.
- User data is not sold or transferred to third parties.
- User data is not used for advertising, creditworthiness, or lending.
- User data is not available for human review.
- Data transmissions are limited to BGG/Geekdo HTTPS endpoints required for the feature.

## Assets

- Store icon: `icons/icon-128.png`
- Screenshot: `store-assets/onboarding-1280x800.png`
- Screenshot: `store-assets/options-1280x800.png`
- Small promotional tile: `store-assets/promo-440x280.png`
