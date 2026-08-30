# Privacy policy

**Effective date:** August 15, 2026

**Developer:** Terwox

**Contact:** [terwox@gmail.com](mailto:terwox@gmail.com)

BGG Hard Block processes BoardGameGeek (BGG) data locally in the browser for one
purpose: removing content from users the signed-in person has chosen to hide and,
when enabled, keeping BGG's separate user subscription blocks aligned with that
Hidden Users list.

The extension is inactive until the user reviews its in-extension disclosure and
affirmatively agrees. If the disclosure changes, the extension requires agreement
to the new version before processing BGG data again.

## Data used

- BGG Hidden Users identifiers and the public BGG usernames associated with them
- discussion content and author attribution markup rendered on BGG forum indexes,
  forum threads, thumbs lists, GeekLists, images, videos, files, and individual
  blog posts
- reply-draft text BGG inserts into the editor after the user clicks Quote
- the current BGG page address, checked only in memory to enforce the supported
  discussion-page scope and never retained
- the signed-in BGG authorization value, used only in temporary page/background
  memory to call BGG's own API
- the user's subscription-linking preference and local status counts

The extension uses this data only to redact blocked author names on forum
indexes and thumbs popovers; remove blocked posts, native blocked-user
placeholders, quotations
attributed to blocked users, and complete blocked-user quotation subtrees from
BGG-generated reply drafts; report local removal/redaction counts; and, if the
user leaves subscription linking enabled, add missing user-level subscription
blocks to their BGG account. It never removes a subscription block.

## Data storage

The complete local-storage map is:

| Storage entry | Contents |
| --- | --- |
| `bggHardBlockerConsent` | Consent granted flag, disclosure version, and grant time |
| `bggHardBlockerOptions` | Subscription-linking option |
| `bggHardBlockerState` | A provenance schema marker; blocked public usernames; synchronization/result status; blocked, removed, and redacted counts; unresolved count; update times |
| `bggHardBlockerProfileCache` | Blocked BGG profile ID→public username mappings and update times |
| `bggHardBlockerSubscriptionState` | Whether linking is enabled and its synchronization, added, failed, and blocked-user counts and update times |

All five entries use `chrome.storage.local`. Profile-cache entries older than
30 days are never reused; the next successful synchronization removes them and
entries whose IDs are no longer in the current BGG Hidden Users result. Version
0.4.0 also removes the obsolete profile cache that earlier
versions placed in BGG-origin `localStorage`. It rejects and removes unversioned
block-list state written by the former page-data bridge before using a cache.

Reply drafts are processed only in the currently open BGG page. The extension
does not store them in Chrome extension storage, BGG local storage, or anywhere
else.

The extension's filtering and BGG-data code is limited to canonical HTTPS URLs for those seven BGG
discussion page families. It does not activate filtering or credential capture
on BGG's home page, game pages, collection, store, account pages, or any other
site. After a single-page route leaves a supported page, a tiny local teardown
function may run on the destination BGG page only to remove previously installed
behavior; it reads no page data and makes no network request. Chrome treats
host permissions as origin-wide even when URL paths are declared. The canonical
BoardGameGeek origin is used to identify and attach code only on supported
discussion pages. The canonical `api.geekdo.com` origin is used only for the
enumerated Hidden Users, public-profile, and optional subscription-block API
requests described below.

The extension does not store the BGG `GeekAuth` authorization value. After
current consent is verified, the background worker can observe it on an existing
BGG-initiated request to `https://api.geekdo.com/api/*` through Chrome's read-only
request event. The worker validates the active tab is a supported discussion and
rechecks stored consent for that event before reading the header, then binds the
value to its exact document; an unused observation expires after five seconds.
A document-bound MAIN-world capture remains as a private fallback. The
value is never exposed to the DOM or isolated content script. The worker
constructs only enumerated exact `https://api.geekdo.com` requests, refuses
redirects, and does not accept API response data or request parameters from page
code.

There is no declarative MAIN-world or settings bridge. The worker checks current
consent and the subscription option before credential use, before network work,
before each subscription addition, and before it saves or returns the public
result. Usernames and status return only through Chrome extension messaging;
there is no page-DOM data bridge. The only cross-world DOM event is a data-free,
random-nonce-bound revocation signal
when the page wrapper observes a native Hidden Users mutation. Its isolated
relay can only ask the worker to pause optional subscription linking for that
active document; it carries no user data, credential, identifier, destination,
or write authority.

The worker reads Hidden Users again immediately before each subscription
addition. Geekdo nevertheless provides only a separate `GET` and unconditional
`PUT`, with no conditional revision token, so those requests are not atomic. A
native Hidden Users change can occur between them; the revocation signal reduces
that race window but does not eliminate it.

## Data sharing

The extension has no analytics, advertising, telemetry, remote code, developer
server, or third-party service. Terwox does not receive or have access to extension
user data. Data is sent only to BGG/Geekdo endpoints that BGG's own frontend uses,
over HTTPS, when necessary to provide the disclosed features.

## Limited use

BGG Hard Block's use of information complies with the Chrome Web Store User Data
Policy, including the Limited Use requirements. Data is used only for the
extension's disclosed single purpose. It is not sold, transferred to third parties,
used for advertising or credit decisions, or made available for human review.

## Retention and deletion

Local extension data remains in the Chrome profile until Chrome clears it or the
extension is removed. Cached BGG profile mappings older than 30 days are ignored
and removed by the next successful synchronization, which also prunes mappings
to IDs in the current Hidden Users result. Removing the extension
deletes its Chrome extension storage. Subscription blocks already written
to the BGG account remain under the user's control in BGG's native subscription-
block editor.

## Changes

Material changes to data handling will be disclosed inside the extension and will
require fresh affirmative agreement before the changed practices begin.
