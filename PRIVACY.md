# Privacy

BGG Hard Block processes BoardGameGeek forum pages locally in the browser.

## Data used

- the signed-in user's BGG block-list user IDs
- public BGG usernames associated with those IDs
- the text and attribution markup already rendered on the current BGG forum page
- local counts of posts and quotations removed

## Data storage

The extension stores the blocked usernames, latest synchronization time, current-page removal counts, and latest forum URL in Chrome's local extension storage. BGG profile ID-to-name mappings are cached in BoardGameGeek local storage for up to 30 days.

The extension does not store the BGG `GeekAuth` authorization value. It exists only in page memory while the live block list is synchronized.

## Data sharing

The extension has no analytics, advertising, telemetry, remote code, or third-party service. It sends no data anywhere except the BoardGameGeek/Geekdo endpoints that BGG's own frontend uses.
