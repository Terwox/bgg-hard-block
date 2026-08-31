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

---

## 2026-08-30, second session — the consent gate is not the defect

### New coverage: `tests/consent_gate_e2e.py`

The missing test now exists. It loads the **real unpacked extension** into
headless Chrome, points `boardgamegeek.com` and `api.geekdo.com` at a local
HTTPS stub with `--host-resolver-rules`, clicks the genuine "Agree and enable"
button on the real onboarding page, opens a genuine
`https://boardgamegeek.com/thread/1/article/1`, and reads `chrome.storage.local`
from the extension's own context over CDP. Two modes:

- `--` (default) — consent first, then open the tab.
- `--tab-first` — tab already open when consent is granted, which is Alice's
  actual situation, and which also exercises the post-consent refresh.

It is wired into `scripts/test.sh`.

### It passes against current `main`. Both modes.

```
consent_gate_e2e[consent-first]: PASS
consent_gate_e2e[tab-first]:     PASS
```

The full observed chain on a clean profile: consent recorded → content script
past the gate → live sync → `BlockedUser`'s post removed → page revealed →
`bggHardBlockerState` written with `source: "live"`, `blockedCount: 1`.
`bggHardBlockerProfileCache` and `bggHardBlockerSubscriptionState` are written
too. **The extension works end to end headless.**

### The test is not vacuous — negative control

`DISCLOSURE_VERSION` in `content.js` was temporarily changed to a value the
onboarding page does not write, simulating a gate that refuses. The test failed
on exactly the assertions it should:

```
- consent gate refused after consent was granted (data-bgg-hard-blocker-running absent)
- blocked user's post was not removed
- bggHardBlockerState was never written to chrome.storage.local
  dom: {"ready": true, "running": false, "redacted": 0, ...}  storage: [consent, options]
```

The patch was reverted; `git diff src/content.js` is clean.

### ⚠️ This disproves the earlier inference — `running` + `ready` is NOT the refusal branch

The first session concluded: *"`stopContentScript()` removes `RUNNING_ATTRIBUTE`,
so a path that leaves both set can only be the consent-refusal return in
`content.js`."*

That is wrong, and the negative control demonstrates it directly.
`RUNNING_ATTRIBUTE` is set on **line 798 — the last statement of the async IIFE**,
*after* the consent gate at line ~197. A consent refusal returns at line 204 and
therefore **never sets `RUNNING_ATTRIBUTE` at all**. The measured refusal state is
`running: false, ready: true`, not `running: true, ready: true`.

So Alice's reported `<html>` state — **both** attributes set, zero redacted
elements, no `bggHardBlockerState` — cannot be the consent-refusal branch. It is
the signature of the script running **all the way to completion** while
`hasBlockList` stayed `false`:

- `writeStatus()` and `scheduleStatusWrite()` both early-return unless `hasBlockList`.
- `bggHardBlockerState` is written by `replaceCanonicalContentState()` in
  `background.js`, only after `performSync()` succeeds.
- With no list, `scheduleRevealDeadline()` fires at `POST_LOAD_MAX_HOLD_MS`,
  sets `source = "timeout"`, and reveals the page anyway.

Every symptom follows. **The defect is downstream of the consent gate, in the
bridge/authorization/sync path.**

### Open lead 1 — the `active` flag across the await: closed

Not reachable as described. If `active` had flipped, the guard immediately after
the await calls `stopContentScript()`, which *removes* `RUNNING_ATTRIBUTE` —
again the opposite of what was observed. Ruled out by construction and by the
negative control.

### Open lead 2 — post-consent tab refresh: does not reproduce

`--tab-first` asserts it. A marker set on `window` before the consent grant is
gone 4s later (`preConsentMarker: "cleared"`), and the tab comes back fully
filtered. `chrome.storage.onChanged` → `stopAndRefreshDiscussionTabs()` →
`chrome.tabs.reload(..., {bypassCache: true})` fires correctly headless. The
724s-without-reload observation has some other cause and is **not** a second
independent defect in this code path.

### What is still unexplained, and the next diagnostic

Nothing in this repo reproduces Alice's failure on a clean profile. The
difference must be environmental — most plausibly that the service worker never
obtains an `Authorization: GeekAuth …` value on the real machine, which would
make `runBridgeSession` return `sync-failed` / `authorization-unavailable` and
produce precisely the observed state.

Cheap, decisive next check on Alice's actual profile — do **not** re-derive it
from source:

1. Read `chrome.storage.local`. If `bggHardBlockerProfileCache` and
   `bggHardBlockerSubscriptionState` are **also** absent, the sync never
   completed and this is confirmed downstream of consent.
2. Read the content script's `source`. `"timeout"` confirms no list ever arrived.
3. Capture the service worker's response to the bridge message — the `reason`
   field names the failure directly.

Step 1 needs a headed run against the profile Alice is signed into; the
04:00–08:00 window is the place for it.

### Not done

Manifest was **not** bumped to 0.4.3. There is no verified fix to ship, and the
gate demonstrably works headless, so a version bump would claim something untrue.
