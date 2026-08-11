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

By default, it also adds Hidden Users to BGG's separate user-level subscription
blocks. You can turn that linking off in Options. The extension never removes a
subscription block already stored by BGG.

Your existing BGG controls stay available. Use BGG's native Hidden Users and
subscription-block editors whenever you want to review or change either list.

Privacy by design:

- the extension is inactive until you review its disclosure and affirmatively agree
- processing happens locally in your browser
- BGG authentication is used only in page memory and is never stored
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

Attaches the same local filter after BoardGameGeek enters a supported discussion
URL through an in-page route change instead of loading a new document. It is used
only on the seven disclosed discussion-page families and does not grant browsing-
history access.

### `storage`

Stores the user's consent record, subscription-linking preference, cached public
BGG usernames, synchronization time, and local removal/status counts. No data is
synced to the developer or a third party.

### BoardGameGeek page access

Required to read BGG's Hidden Users list through BGG's own HTTPS API, identify
authors in rendered discussion markup, redact matching names on forum indexes,
remove matching posts/placeholders/quotations, sanitize the reply draft BGG
creates after a Quote click, and optionally add missing user-level subscription
blocks to the signed-in BGG account. Filtering and BGG-data code is injected only
on canonical HTTPS forum indexes, forum threads, GeekLists, images, videos,
files, and individual blog posts. It does not run on unrelated BGG
pages or any other site. Chrome ignores URL paths for host permissions, so the
single canonical BGG origin permission is also used to identify supported open
discussion tabs for automatic refresh after consent or extension updates and to
attach the filter when BGG enters a supported URL through an in-page route change.

## Data disclosures

The extension handles these categories solely for its disclosed single purpose:

- personally identifiable information: BGG user identifiers and public usernames
- authentication information: the current BGG authorization value, transiently in page memory
- website content: rendered BGG discussion posts, comments, author attributions,
  and BGG-generated reply-draft text; drafts are processed locally and never retained
- web browsing activity: the current supported BGG discussion address, stored only for local status reporting

The extension does not collect financial, health, location, personal communication,
or advertising-profile data. Terwox receives no extension user data and no human can
review it.

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
