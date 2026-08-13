# Privacy policy

**Effective date:** August 13, 2026

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
- the current BGG page address, used only for local status reporting
- the signed-in BGG authorization value, used only in page memory to call BGG's own API
- the user's subscription-linking preference and local status counts

The extension uses this data only to redact blocked author names on forum
indexes and thumbs popovers; remove blocked posts, native blocked-user
placeholders, quotations
attributed to blocked users, and complete blocked-user quotation subtrees from
BGG-generated reply drafts; report local removal/redaction counts; and, if the
user leaves subscription linking enabled, add missing user-level subscription
blocks to their BGG account. It never removes a subscription block.

## Data storage

The extension stores the user's consent record, blocked usernames, subscription-
linking preference, latest synchronization time, current-page removal counts,
subscription-linking status counts, and latest discussion URL in Chrome's local extension
storage. BGG profile identifier-to-name mappings are cached in BGG local storage
for up to 30 days to avoid repeated profile requests.

Reply drafts are processed only in the currently open BGG page. The extension
does not store them in Chrome extension storage, BGG local storage, or anywhere
else.

The extension's filtering and BGG-data code is limited to canonical HTTPS URLs for those seven BGG
discussion page families. It does not inject on BGG's home page, game pages,
collection, store, account pages, or any other site. Chrome treats
host permissions as origin-wide even when URL paths are declared; the single BGG
host permission is used by the background worker only to identify supported open
discussion tabs for automatic refresh after consent or an extension update and to
attach the same discussion-only code when BGG enters one of those URLs through an
in-page route change rather than a new document load.

The extension does not store the BGG `GeekAuth` authorization value. It exists only
in page memory while the live block list is synchronized and is never exposed to
the extension's isolated content scripts.

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
extension is removed. Cached BGG profile mappings expire after 30 days. Removing
the extension deletes its Chrome extension storage; BGG site data can also be
cleared through Chrome's site-data controls. Subscription blocks already written
to the BGG account remain under the user's control in BGG's native subscription-
block editor.

## Changes

Material changes to data handling will be disclosed inside the extension and will
require fresh affirmative agreement before the changed practices begin.
