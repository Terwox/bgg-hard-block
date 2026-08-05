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
- complete forum posts written by anyone on your BGG Hidden Users list
- quotations attributed to hidden users, while preserving the surrounding reply

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

Remove forum content from users on the signed-in person's BGG Hidden Users list
and, when the user leaves the option enabled, keep BGG's separate user-level
subscription blocks aligned with that same list.

## Permission justification

### `storage`

Stores the user's consent record, subscription-linking preference, cached public
BGG usernames, synchronization time, and local removal/status counts. No data is
synced to the developer or a third party.

### BoardGameGeek page access

Required to read BGG's Hidden Users list through BGG's own HTTPS API, identify
authors in rendered forum markup, remove matching posts/placeholders/quotations,
and optionally add missing user-level subscription blocks to the signed-in BGG
account. The extension does not run on other sites.

## Data disclosures

The extension handles these categories solely for its disclosed single purpose:

- personally identifiable information: BGG user identifiers and public usernames
- authentication information: the current BGG authorization value, transiently in page memory
- website content: rendered BGG forum posts and author attributions
- web browsing activity: the current BGG forum address, stored only for local status reporting

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
