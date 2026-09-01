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

---

## 2026-08-31, third session — reproduced on live BGG; two real defects, one fixed

Run inside the authorized 04:00–08:00 headed window, against `boardgamegeek.com`
signed in as `Terwox`.

### Alice's profile: the predicted storage check came back positive

`chrome.storage.local` for the extension in Alice's real Chrome profile
(`.../Google/Chrome/User Data/Default/Local Extension Settings/hkbnpeoh…`,
read straight off disk) holds **exactly two keys**:

```
bggHardBlockerConsent  {"disclosureVersion":"2026-08-15","granted":true,"grantedAt":"2026-08-30T21:28:47.153Z"}
bggHardBlockerOptions  {"linkSubscriptionBlocks":true}
```

`bggHardBlockerProfileCache`, `bggHardBlockerSubscriptionState` and
`bggHardBlockerState` are **absent**, and the LevelDB was created at 21:28:45Z —
two seconds before consent. So the sync has **never once succeeded** on that
profile. This is the check the previous session specified, and it confirms the
defect is downstream of the consent gate.

### Also found: the extension is currently disabled in both profiles

`disable_reasons: [1]` (`DISABLE_USER_ACTION`) in both Alice's default Chrome
profile and the `rabbit` CDP profile; `chrome.developerPrivate.getExtensionInfo`
reports `state: "DISABLED"` with no policy, corruption, or permission reason.
Navigating to any of its own pages returns `ERR_BLOCKED_BY_CLIENT`. This is
*not* the cause of the reported symptom — a disabled extension injects nothing,
and Alice observed the content script running — but it does mean the extension
is doing nothing at all right now. It was enabled in the `rabbit` profile for
this investigation and restored to disabled afterwards.

### The 4s/5s capture windows are not the problem

Measured on a live thread with CDP network tracing: BGG issues **20**
`api.geekdo.com` requests during load, **7** of them carrying
`Authorization: GeekAuth …`, and the first authorized one lands at **+0.36s** —
comfortably inside `AUTHORIZATION_WAIT_MS` (4s) and `MAIN_CAPTURE_DEADLINE_MS`
(5s). All are `xmlhttprequest` from the main frame with
`initiator: https://boardgamegeek.com`, so they satisfy every filter in
`observedAuthorization`. Timing and realm are **ruled out**.

### Reproduced Alice's exact symptom, and named the failure

Live thread, extension enabled, consent granted, instrumented service worker:

```
DOM:      running:true  ready:true  redacted:0
bridge:   {status:"error", reason:"sync-failed"}
storage:  ["bggHardBlockerConsent","bggHardBlockerOptions"]
```

That is Alice's report exactly, including the "both attributes, nothing
redacted, nothing written" signature.

### Defect 1 — a duplicate MAIN-world entry cancels the capture. **Fixed.**

`chrome.scripting.executeScript` runs `installBggBlockListBridge` **twice in the
same document** for a single call. Captured by defining an accessor over
`__bggHardBlockerPageBridgeInstalled` and `__bggHardBlockerStop`:

```
+181.6ms INSTALLATION_KEY=true    at installBggBlockListBridge (:283)
+182.1ms STOP CALLED              at installBggBlockListBridge (:58)   <- second entry stops the first
+182.2ms INSTALLATION_KEY=false   at stopBggHardBlockerBridge
+182.2ms INSTALLATION_KEY=true    at installBggBlockListBridge (:283)
```

The losing entry resolves `{status:"error", reason:"cancelled"}` ~41ms after
injection. In `runBridgeSession` that result **wins the capture race**, so the
session gives up at ~+230ms and injects `stopPageBridge`, which then also kills
the replacement entry that was still waiting. The real `GeekAuth` header does
not arrive until **+809ms** — the session had already reported `sync-failed`
~580ms earlier.

Note `tests/page-bridge-security.html::runDuplicateInstallScenario` already
covered this page-level scenario and asserts the *replacement wins* contract
deliberately. That contract is fine; the bug is that `background.js` treats the
displaced entry's `cancelled` as a terminal session failure.

**Fix:** in `runBridgeSession`, a MAIN entry that resolves with
`reason === "cancelled"` no longer ends the capture race — the session keeps
waiting for the observed-header fallback or the 5s deadline. Every other bridge
failure stays terminal. Regression test:
`background.test.js::"keeps the capture open when a duplicate MAIN entry reports
cancelled"`, which fails on the unfixed `background.js` with `'error' !== 'ready'`.

### Defect 2 — a spurious `status:"loading"` invalidates a live document. **Fixed headless 2026-09-01; see the fourth session below.**

Loading the same live thread with the *fixed* build (unpacked, real BGG, signed
in) does **not** sync either. The MAIN capture now succeeds:

```
+182ms  exec:start  installBggBlockListBridge MAIN
+804ms  exec:end    {"status":"ready","authorization":"GeekAuth …"}
+804ms  performSync:start
+858ms  performSync:err  AbortError: signal is aborted without reason
+858ms  bridge:end  {"status":"error","reason":"sync-cancelled"}
```

The abort comes from `background.js:1114` — the `chrome.tabs.onUpdated`
listener. BGG fires a **second** `status:"loading"` around +949ms **with no URL
change** on a document that never went away:

```
+163ms  onUpdated {"status":"loading","url":"https://boardgamegeek.com/thread/3760807/…"}  <- the real navigation
+949ms  onUpdated {"status":"loading"}   keys:["status"]   tabUrl unchanged               <- spurious
+949ms  abortTabSyncs -> background.js:1114
+949ms  bridge:end {"status":"error","reason":"stale-document"}
+1133ms deliverAuth x8                                                                    <- fallback arrives too late
```

The handler treats any `status:"loading"` as a new navigation: it bumps
`tabRouteRevisions`, calls `abortTabSyncs`, and runs `clearTabDocumentSessions`,
which also discards the observed-authorization waiters. So both capture paths
are destroyed for a document that is still current.

This explains why the internal reason varies run to run — `sync-failed`,
`sync-cancelled`, `stale-document` — while the user-visible symptom is always
identical: `running` + `ready`, zero redacted, nothing written.

Fixing this needs judgment and was deliberately **not** attempted at 05:40:
`status:"loading"` without `changeInfo.url` is also what a genuine reload looks
like, and that invalidation is the trust boundary that stops an authorization
being reused across navigations. Loosening it blind is the wrong move. The
promising direction is to leave invalidation alone and let the content script
**retry** the bridge handshake when it receives `stale-document` while its own
document is still current, rather than calling `acceptBridgeError()` once and
giving up.

### Not done

Manifest was **not** bumped to 0.4.3. Defect 2 still blocks any sync on the live
site, so the gate does not demonstrably work end to end and a version bump would
claim something untrue.

## 2026-09-01, fourth session — Defect 2 fixed headless; live verification still owed

### Defect 2 — **fixed in the content script, not in the invalidation.**

The service worker's `chrome.tabs.onUpdated` handler is unchanged. Any
`status:"loading"` still bumps `tabRouteRevisions`, aborts the tab's syncs and
clears its document sessions, because that is the boundary that stops an
authorization captured for one document being reused by another, and
`status:"loading"` without `changeInfo.url` is also exactly what a genuine
reload looks like. There is no way to tell BGG's spurious event from a real one
at that layer, so nothing there was loosened.

Instead the document that lost the race asks again. `src/content.js` now
retries `initialize-bridge` when the answer is `stale-document` or
`sync-cancelled` — the two reasons that mean "your session was invalidated",
not "your request was refused" — at +300ms and +900ms, then accepts the error.

Why this is safe:

- A document that genuinely navigated away has no content script left to retry.
- An SPA route change runs `teardownDiscussionScripts` -> `stopContentScript`,
  which sets `active = false` and now also clears the pending retry timer, so a
  scheduled retry cannot fire into a scope that was torn down.
- Every attempt is a whole new `runBridgeSession`: tab URL, `pendingUrl`,
  `isDiscussionUrl`, consent, `documentId` and both revision counters are
  revalidated from scratch. A retry cannot smuggle a stale authorization past a
  check the first attempt would have failed.
- The retry is bounded at two, and `POST_LOAD_MAX_HOLD_MS` (500ms) still
  releases the page long before the retries finish, so a tab that keeps
  invalidating fails open and readable rather than blank.

Timing is deliberate. The live trace has the spurious invalidation at ~+949ms
and BGG's own `deliverAuth` burst at ~+1133ms, i.e. *after* the invalidation.
`clearObservedAuthorizations` has already run by then, so those headers land in
`recentAuthorizations`, which the service worker holds for
`RECENT_AUTHORIZATION_MAX_AGE_MS` = 5000ms. A retry at ~+1250ms therefore has a
warm observed header waiting for it and does not depend on BGG issuing another
authenticated request inside the MAIN bridge's 4s window.

### New coverage: three content-runtime fixtures

`filterDom`-style fixtures could not have caught this; the gap was in what the
content script does with a *rejected* bridge answer. All three drive the real
`src/content.js` bridge path:

| fixture | asserts | against `main` |
| --- | --- | --- |
| `tests/bridge-retry-runtime.html` | `stale-document`, then `sync-cancelled`, then ready — 3 attempts, one shared nonce, first retry waits >=250ms, post filtered, status written | **FAIL** — `1 bridge attempts, expected 3`; `the retried sync did not filter`; `did not report content status` |
| `tests/bridge-retry-exhausted.html` | always `stale-document` — exactly 3 attempts and no fourth, page still revealed, nothing filtered | **FAIL** — `1 bridge attempts, expected exactly 3` |
| `tests/bridge-retry-terminal.html` | `sync-failed` — exactly 1 attempt | PASS (guard, not a regression) |

Red confirmed by restoring `main`'s `src/content.js` and running the three
fixtures before applying the fix; green after. Full suite with the fix: 111
Node unit tests, 12 release-tooling tests, 21 browser fixtures, both
`consent_gate_e2e` modes — all pass.

### Not done — and why the manifest is still 0.4.2

**The fix has not been observed working on live boardgamegeek.com.** Everything
above is headless-fixture evidence that the content script now re-asks and that
a re-ask can succeed; it is not evidence that a real thread on Alice's profile
syncs. The bar set for the version bump was "the gate demonstrably works", and a
green fixture is not that. Bumping to 0.4.3 now would claim a live fix nobody
has seen, which is exactly the mistake 0.4.2 made. Manifest stays at 0.4.2 until
a live headed run shows a thread syncing end to end.
