# 0.4.2 consent-gate defect — investigation log

*Opened 2026-08-30. Alice reported blocked users' quotations reappearing on BGG
discussion pages.*

## Symptom

On a BGG discussion page with consent granted:

- `<html>` carries **both** `data-bgg-hard-blocker-running` and
  `data-bgg-hard-blocker-ready`
- zero elements carry `data-bgg-hard-blocker-redacted`
- `bggHardBlockerState` is **never written** to `chrome.storage.local`
- the popup therefore shows its placeholder, "Waiting for a BGG discussion page",
  and em-dashes for every counter, because `popup.js` does `if (!status) return;`

`running` + `ready` together identify the branch precisely:
`stopContentScript()` *removes* `RUNNING_ATTRIBUTE`, so a path that leaves both
set can only be the consent-refusal return in `content.js`.

## Reproduced off-screen

`scripts/ext-repro.sh start` — headless Chrome, throwaway profile, extension
loaded unpacked, driven over CDP. The real "Agree and enable" button is clicked;
storage is then read from the extension's own context.

Reproduces on a clean profile, so this is **not** environment-specific and not
the unpacked-vs-store extension-ID split.

## Ruled out, with evidence

| Hypothesis | Verdict |
|---|---|
| Quote attribution parsing | **No.** `tests/live-angular-quote.html` uses BGG's verbatim 2026-08-30 markup and passes. |
| URL pattern matching | **No.** `/^\/thread\//` matches `/thread/<id>/article/<id>`. |
| Consent storage key mismatch | **No.** `bggHardBlockerConsent` in all five files. |
| Disclosure-version ladder drift | **No.** Byte-identical across `content`/`background`/`onboarding`/`options`/`popup`; 0.4.2 resolves to `2026-08-15` in every one. |
| Version source drift | **No.** All five use `chrome.runtime.getManifest().version`. |
| Consent never written | **No.** After clicking Agree: `{granted: true, disclosureVersion: "2026-08-15"}`. |
| Write ordering in onboarding | **No.** `onboarding.js` awaits `storage.local.set` before reporting success. |

So the stored record is present and correct, the expected value matches, and the
gate still rejects it.

## Open leads

1. **The `active` flag.** The consent check sits *after* `await
   chrome.storage.local.get(CONSENT_KEY)`. `active` can change across that await.
   The guard immediately before it calls `stopContentScript()`, which removes
   `RUNNING_ATTRIBUTE` — not what we observe — so the refusal `return` below it
   is the branch being taken.
2. **Post-consent tab refresh never fires.** `onboarding.js` states the
   background "hard-refreshes open BGG discussion tabs" on the storage change.
   On Alice's machine a discussion tab sat 724s across two consent grants
   without reloading. Possibly a second, independent defect.

## Missing coverage this exposes

No existing test asserts that **`bggHardBlockerState` is written after consent is
granted**. Every current fixture calls `filterDom` directly, bypassing the
consent gate entirely. That is why a total functional failure passed 110 unit
tests and 18 browser fixtures.
