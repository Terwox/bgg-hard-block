# Audit results

## Outcome

The audit found and corrected a high-impact provenance weakness: the extension's
authenticated application programming interface (API) requests and response
interpretation previously ran in BoardGameGeek's page-controlled MAIN realm.
All extension-originated authenticated API fetches now run in the background
worker. The MAIN-world code captures one `GeekAuth` authorization value and
observes native Hidden Users mutations only to revoke optional subscription
linking and schedule refresh. It returns the credential through the private,
document-bound `chrome.scripting.executeScript` result and performs no API
processing. Page code no longer supplies block-list data, persistence input,
subscription status, request destinations, or write identifiers.

The current implementation also removes the page-writable metadata and
`CustomEvent` trust channels, places authenticated sessions in a strict
request-order first-in, first-out (FIFO) queue, limits canonical persistence to
the latest authenticated generation, coordinates observed native hidden-list
mutations with fail-closed subscription deferral, tears down both worlds when a
single-page application (SPA) route leaves scope, rejects legacy content state,
narrows mutation work, repairs the Cascading Style Sheets (CSS) attachment
failsafe, makes storage claims explicit, and hardens release tooling. These are
verified code and test findings.

Two temporary-profile network smokes passed: the live smoke reached its
`observed-markup-fallback` path, and the same-document SPA smoke verified route
attachment without a full navigation. The first result exercised consent,
refresh, extension attachment, and filtering against substituted observed
markup; it did **not** validate current live BGG markup. Neither smoke exercised
an authenticated live BGG API response. Current live BoardGameGeek (BGG) markup
and authenticated API compatibility therefore remain unverified.

## Verified findings and fixes

| Area | Verified finding | Implemented fix and evidence |
| --- | --- | --- |
| API provenance | Authenticated fetches and response processing in a page-controlled realm created an avoidable provenance boundary: page behavior could influence data used by the extension. | `src/background.js` now constructs, validates, fetches, and interprets every authenticated request. `src/page-bridge.js` is limited to credential capture plus revocation-only native-mutation observation, not API processing. MAIN-world header inspection is one-shot: after the capture result settles, the fetch wrapper does not evaluate either `input.headers` or `init.headers`, the XMLHttpRequest header hook is restored, and the credential-bearing result returns from a separate lexical scope so long-lived mutation wrappers retain no authorization binding. A Proxy-backed `init.headers` regression enforces that no post-settlement access occurs. Background and browser tests reject forged response fields and confirm the credential is absent from Document Object Model (DOM) payloads, storage, public responses, console output, and generic errors. |
| Page-to-extension trust | Page-writable metadata and events could not provide trustworthy settings or block-list data. | The settings bridge and DOM event data bridge were removed. The isolated content script accepts a bounded public result only through extension messaging and can report only bounded tab-local filtering counters; the background worker owns canonical usernames, synchronization provenance, and the latest-generation write. A signed-out cache-only page may independently register a counters-only status session, but only after exact tab/document confirmation and current-consent, route-revision, and authorization-revision checks. `bridge-trust-runtime.html` confirms fixed, random, and nonce-bearing DOM payloads cannot filter, reveal, or persist data. |
| Consent, navigation, and session races | Consent, option, document, route, and concurrent-document changes can race long-running synchronization. | Each accepted request reserves a strict FIFO position before capture, and privileged work is globally serialized. The worker owns a five-second relay-and-capture deadline; after capture, FIFO wait and trusted synchronization share a subsequent 20-second deadline. Newer captured generations do not abort older privileged work: concurrent documents can both return `ready`, while only the latest authenticated overlapping generation persists. Early exits release reservations without overtaking active work, and detached best-effort cleanup cannot retain the global FIFO. Pending navigation is rejected, and the live tab URL must exactly equal the sender URL before injection. Three-tab stale-writer coverage proves an older tab can update only bounded counters without resurrecting its usernames. Cache-only status registration and writes are exact-tab/document, current-consent, route-revision, and authorization-revision bound; deterministic gates cover consent change during document confirmation, navigation while queued, and navigation during storage with exact restoration. Generation supersession, consent withdrawal, route exit, and generic or storage failures use exact rollback; an older compare-and-remove rollback finishes inside its reservation before the next session can persist. Tab loading/navigation and closure abort and clean tab-owned work. |
| API and subscription safety | Redirects, pagination, response schema, identifier count, request fan-out, and native-unblock races needed explicit bounds. | Requests are exact-method and exact-origin allowlisted, omit credentials, refuse redirects, cap each response at 2 MiB, and cap one synchronization at 6,000 requests and 16 MiB of aggregate response data. Block lists are capped at 5,000 IDs, pagination at 100 pages, and profile concurrency at six. Subscription pages require strict `feeds` and `links` schemas; malformed pages cause zero `PUT`. A fresh hidden-list `GET` before each candidate addition skips an already-visible native unblock, but it is a risk-reduction check rather than an atomic precondition. |
| Native mutation coordination | A native hidden-list mutation in another open BGG document can race optional subscription linking. | A nonce-bound MAIN-world observer notifies an isolated relay, which sends a validated runtime message to increment the linking epoch and suspend linking. Observed mutation between the final hidden-list `GET` and `PUT` produces zero `PUT` and a deferred subscription state; later trusted work may resume only after quiescence and complete enumeration. Relay teardown and tab-close registration cleanup are tested. Options and popup fixtures verify that deferred work is rendered through text-only DOM operations as paused, explains the native mutation, and identifies the next supported-page retry rather than reporting a generic failure. |
| Filtering performance and mutation completeness | Mutation bursts rebuilt the normalized blocked set and scheduled broad document work more often than needed; removal-only hydration could change the fallback author without adding a node. | Normalized sets are reused. Mutation roots are deduplicated and filtered at the broadest necessary subtree; the full-document fallback is reserved for unclassified content. A removal-only fixture confirms fallback author reclassification. The 640-post benchmark recorded zero route-time document sweeps and no blocked-set reconstruction. |
| Reveal and CSS failure behavior | Reveal state mixed cache, bridge, and status concerns, and the CSS-only attachment failsafe did not hide during its delay before revealing at two seconds. | Explicit cache, bridge, list-revision, and reveal states gate first paint. The CSS fix separates the running-script hold and uses backwards-and-forwards animation fill with an explicit hidden first keyframe. Dedicated failure and failsafe fixtures verify pre-attachment hiding, two-second reveal, bounded script failure reveal, and quarantine behavior. |
| SPA scope | Supported-to-unsupported route changes could leave filtering behavior, attributes, CSS, or late responses active; reentry could race teardown. | Background route tasks are ordered per tab, leaving scope aborts tab synchronization and tears down MAIN and isolated worlds, late responses remain inert, and supported reentry waits before reinjection. Initial unsupported injection, teardown/reentry, and route-persistence rollback are tested. The same-document smoke now calls `window.stop()` to freeze any in-flight Cloudflare challenge before its synthetic `history.pushState`, making the route assertion deterministic without treating the challenge page as current-markup evidence. |
| Storage and retention | The profile cache lived in BGG-origin storage, public storage descriptions were incomplete, unversioned content state could be trusted across incompatible implementations, and status unnecessarily retained the full discussion URL. | The cache moved to `chrome.storage.local`; entries older than 30 days are never reused, and the next successful synchronization removes them, prunes IDs no longer in the current Hidden Users result, and removes the obsolete origin-storage entry. Content state now writes `schemaVersion: 1`; reads reject legacy state, install or consent migration removes it, and regressions prove that only background-owned canonical usernames plus status are persisted while the full active page URL is checked only in memory and never retained. `PRIVACY.md` enumerates all five extension-storage records. |
| Release and helper tooling | Packaging admitted directory-derived input and did not prove Windows/Linux byte identity; Chromium cleanup was POSIX-specific, and transient Windows locking or a slow hosted cold start of `DevToolsActivePort` could fail an otherwise healthy browser run. | Packaging now uses a tracked-file allowlist, fixed stored ZIP metadata, LF normalization, hash-locked test tooling, commit-SHA-pinned actions, and a cross-platform CI comparison. Shared process helpers hide Chromium on Windows, terminate its process tree on both platforms, and allow a bounded hosted cold start while retrying the debug-port marker and still failing promptly if Chromium exits. Hosted CI run 31911735766 passed Linux extension checks, Windows packaging, and byte-for-byte Windows/Linux comparison. |

## Performance evidence

The recorded ranges below come from five post-fix runs of the 640-post Chromium
fixture. They are fixture measurements, not production-site timings.

| Measure | Recorded range or count | Interpretation |
| --- | --- | --- |
| Initial reveal | 21.7–52.3 ms | Below the 2,000 ms fixture budget. |
| Initial filtering | 11.9–12.3 ms | Total filtering work for the initial 640-post document. |
| Maximum single filtering pass | 6.5–6.7 ms | The slowest observed pass remained below one 60 Hz frame interval. |
| Route build and insertion | 6.3–10.2 ms | Construction and insertion of the 120-post replacement. |
| Route filtering | 1.0–1.8 ms | Targeted filtering across exactly 120 route roots. |
| Route result | 105 of 120 posts retained | The 15 blocked route posts were removed. |
| Route-time full-document sweeps | 0 | The classified route burst remained subtree-scoped. |
| Blocked-set constructions | 2 initially; stayed at 2 | Mutation filtering reused the normalized set. |
| Heap delta telemetry | Quantized to 0 | This does **not** demonstrate zero allocation; the available browser telemetry lacked sufficient resolution. |

## Verification evidence

Local verification on August 15, 2026 passed:

- 106 background-worker tests
- manifest parsing and the manifest-scope test
- exactly 17 headless-Chromium fixtures listed in `scripts/test.sh`, including
  bridge security, consent, mixed versions, mutation targeting, reveal and CSS
  failure, trust-boundary, deferred-status UI, SPA teardown, and 640-post
  performance cases
- 12 Python release-tooling tests
- manifest parsing, JavaScript syntax checks for every `src/*.js` file, and
  `git diff --check`

The controlled API and DOM suite passed locally. In addition, the signed-out
`observed-markup-fallback` live smoke proved cache-only filtering and counters-
only status self-registration, and the same-document SPA smoke passed after
stopping an in-flight Cloudflare challenge before synthetic `history.pushState`.
These runs used temporary headless Chromium. The fallback result does not
establish current live markup compatibility, and neither smoke establishes
authenticated API behavior. Hosted continuous integration (CI) run 31911735766
also passed Linux extension checks, Windows packaging, and byte-for-byte
Windows/Linux package comparison. No Chrome Web Store artifact comparison or
release publication is part of this evidence.

## Recommendation traceability and ranking

Ranks use 1–5, where 5 means greatest security impact, strongest evidence,
greatest readability or measured speed benefit, greatest regression risk, or
greatest implementation cost. Cost and regression risk therefore rank the
downside, not the desirability. Evidence ranks describe this audit's support,
not certainty about future BGG behavior.

| # | Merged recommendation | Result | State | Security | Evidence | Readability | Speed | Regression risk | Cost |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Map claims to code and coverage | The public claims, implementing modules, and tests were reconciled; this table is the final index. | Implemented | 3 | 5 | 5 | 1 | 1 | 2 |
| 2 | Audit authorization-header containment | Capture is private and ephemeral; authenticated API work moved to the worker; one-shot header inspection stops before evaluating either input or init headers after settlement, restores the XMLHttpRequest hook, and leaves long-lived mutation wrappers outside the result's credential-bearing lexical scope. A proxied-init regression and other leakage tests enforce the boundary. | Implemented | 5 | 5 | 4 | 1 | 4 | 5 |
| 3 | Threat-model metadata and event bridges | Page-writable trust channels were removed; runtime messaging is validated and sanitized. Cache-only signed-out status self-registration accepts only bounded counters after exact document and authorization-state checks. | Implemented | 5 | 5 | 4 | 1 | 4 | 5 |
| 4 | Verify consent across lifecycle and races | Version ladders, startup, mixed versions, withdrawal, interceptor shutdown, the worker-owned five-second capture phase, the subsequent shared 20-second FIFO-and-sync deadline, strict FIFO serialization, concurrent-document readiness, latest-authenticated-generation persistence, three-tab stale-writer prevention, queue early exits, detached-cleanup isolation, exact rollback, loading/navigation aborts, tab-close cleanup, and initial/route rollback are covered. Deterministic cache-only gates exercise consent during exact-document confirmation, navigation while queued, and navigation during storage. | Implemented | 5 | 5 | 3 | 1 | 5 | 5 |
| 5 | Audit subscription reconciliation and pagination | Addition-only reconciliation, strict page schemas, zero write on malformed data, a fresh hidden-list check before every candidate `PUT`, observed-native-mutation revocation and deferral, text-only paused/deferred UI, and strict origin, method, query, page, identifier, redirect, 6,000-request, 16 MiB aggregate, and 2 MiB per-response bounds are tested. This is the strongest observed-mutation fail-closed behavior available from the exposed operations, not an atomic transaction. | Implemented mitigation; atomicity gap remains | 5 | 5 | 3 | 2 | 5 | 5 |
| 6 | Stress username, profile, quote, and BBCode matching | Fixtures cover UTF-8 and malformed percent encoding, locale-stable casing, Latin/Cyrillic homoglyph separation, malformed nested BBCode, and a 1 MiB malformed quote under a 1,500 ms budget, in addition to normal matching cases. Only systematic property and fuzz coverage remains hypothetical. | Implemented cases; fuzz gap remains | 3 | 4 | 2 | 2 | 3 | 4 |
| 7 | Sweep script and markup injection sinks | Source inspection found BGG-derived display values routed through text-only DOM operations; fixtures verify inert `Blocked` replacements. | Verified, no new sink found | 4 | 4 | 2 | 1 | 2 | 2 |
| 8 | Audit permissions, URLs, injection, and routes | The manifest has one isolated declarative script; background validation and manifest tests align on canonical HTTPS discussion routes. The worker rejects any pending navigation and requires the live tab URL to exactly equal the sender URL before document-bound injection or cache-only status registration. Supported-to-unsupported teardown, initial scope races, ordered reentry, same-document attachment, mutation-relay teardown, and tab-close relay cleanup are tested. | Implemented | 5 | 5 | 4 | 2 | 5 | 5 |
| 9 | Audit browser and Python helpers | Temporary profiles, hidden Windows launch, retrying Windows-safe debug-port discovery, exact extension-target selection, and cross-platform process-tree cleanup are implemented and unit-tested. The fallback live smoke proved signed-out cache filtering and counters-only status reporting. The SPA smoke now stops an in-flight Cloudflare challenge before synthetic `pushState`, and both tools passed; current live markup and authenticated API behavior remain untested. | Implemented tooling; live API gap remains | 3 | 5 | 4 | 1 | 3 | 3 |
| 10 | Benchmark mutation and DOM filtering | The 640-post benchmark and mutation-targeting fixtures quantify passes, sweeps, set reuse, route work, coarse heap telemetry, and removal-only reclassification. | Implemented | 2 | 5 | 3 | 5 | 3 | 4 |
| 11 | Measure first paint and reveal failure modes | Cache, bridge, storage-failure, delayed content, mixed-version, script deadline, and the repaired CSS-only two-second failsafe are fixture-tested. Signed-out cache-only fallback filtering and counter reporting passed in the network smoke; authenticated live timing remains unmeasured. | Partial | 3 | 5 | 4 | 4 | 4 | 4 |
| 12 | Measure cold-cache profile resolution | Fan-out is capped at six. Worker-owned relay and capture have a five-second deadline; FIFO wait and trusted synchronization then share a separate 20-second deadline. One sync is also bounded to 6,000 requests, 16 MiB aggregate response data, and 2 MiB per response. Live rate-limit behavior and batch-endpoint availability remain unverified. | Implemented mitigation | 4 | 4 | 3 | 3 | 3 | 3 |
| 13 | Review content and bridge readability | Reveal state is explicit; page-bridge scope is credential capture plus revocation-only native-mutation observation, not API processing; one-shot credential state is lexically separated from long-lived mutation wrappers; mutation logic is named; and duplicated settings-bridge code was removed. Worker complexity remains a maintenance risk. | Implemented | 3 | 4 | 5 | 2 | 3 | 4 |
| 14 | Enumerate writes and reconcile retention | Five extension-storage records are documented and source-traceable. The background worker owns canonical usernames and synchronization metadata; content, including cache-only signed-out pages, can report only bounded page counters after exact session registration. Credentials and drafts are excluded, and the full active page URL is checked only in memory and never retained. Cache entries older than 30 days are never reused; the next successful sync removes them and non-current IDs. Content state writes schema 1, rejects legacy values, removes them on install or consent migration, and has three-tab stale-writer plus generation-, consent-, navigation-, and failure-rollback coverage. | Implemented | 4 | 5 | 5 | 2 | 4 | 4 |
| 15 | Check user and maintainer documentation for drift | README, privacy, security, build, store, onboarding, and contributor guidance were updated. The fallback smoke does not substantiate current-live-markup or authenticated-API claims. | Partial | 3 | 4 | 5 | 1 | 2 | 3 |
| 16 | Audit CI, packaging, hashes, and provenance | Allowlisted deterministic packaging and release tests pass locally; CI pins toolchains/actions, and hosted run 31911735766 passed Linux checks plus byte-for-byte Windows/Linux package comparison. Store-upload provenance remains a release gate. | Implemented; store provenance remains | 4 | 5 | 4 | 1 | 3 | 4 |
| 17 | Produce a gap-driven regression plan | The highest-risk gaps became 106 background-worker tests, 17 browser fixtures, and 12 release-tooling tests, including adversarial and post-settlement bridge access, consent, schema, request and response budgets, subscription, FIFO timing and concurrency, cache-only exact-session races, stale-writer prevention, exact rollback, native mutation, deferred UI, relay teardown, tab cleanup, CSS failure, removal-only mutation, browser-process reliability, and performance cases. | Implemented | 5 | 5 | 4 | 3 | 3 | 5 |
| 18 | Merge, separate, and rank audit outputs | Verified fixes, measured evidence, residual hypotheses, and ranked recommendations are consolidated here. | Implemented | 2 | 5 | 5 | 1 | 1 | 2 |

## Remaining hypotheses and residual risks

These are not verified findings. They should remain open until the stated
validation produces evidence.

| Priority | Hypothesis or residual risk | Why it remains open | Validation gate |
| --- | --- | --- | --- |
| 1 | Current live BGG markup or authenticated API contracts may differ from the fixtures. | The live smoke passed only after entering `observed-markup-fallback`; the SPA smoke proved same-document attachment but did not inspect current discussion markup or authenticated API responses. No authenticated live API response was exercised. | Run an authenticated disposable-profile smoke against current markup and every supported discussion family, record the contract date, and confirm filtering, API synchronization, subscription safety, and safe failure. |
| 2 | An unobserved native hidden-list mutation may still race an optional subscription `PUT`. | This is the strongest fail-closed coordination available for observed mutations, but it is not atomic. Geekdo exposes a separate hidden-list `GET` and unconditional subscription `PUT`, with no revision, ETag, or conditional token. Cross-world runtime notification is asynchronous, so a mutation can occur after the final `GET` without its relay notification arriving before the `PUT`. | Treat deferral as defense in depth; seek a documented conditional or transactional Geekdo operation. Until one exists, preserve the observed-mutation tests and disclose the remaining race rather than claiming atomic reconciliation. |
| 3 | Matcher behavior outside the concrete locale, homoglyph, malformed, and 1 MiB cases may contain unknown bypasses or overmatches. | The named adversarial cases pass, but no systematic property or fuzz corpus defines the wider input space. | Add bounded property and fuzz cases with explicit identity semantics and runtime budgets before changing matcher behavior. |
| 4 | Six concurrent cold-cache profile requests may still trigger real BGG throttling or poor latency for large block lists. | The concurrency ceiling is unit-tested, but no live rate-limit envelope or supported batch endpoint was established. | Measure representative cold-cache lists against documented or observed service limits; reduce concurrency or adopt a documented batch endpoint only if evidence supports it. |
| 5 | Production memory may grow during repeated route changes despite a reported zero heap delta. | `performance.memory` was quantized to zero in the benchmark environment. | Use precise memory instrumentation or repeated heap snapshots across many route cycles and compare retained nodes after garbage collection. |
| 6 | Store provenance may diverge from the verified release artifact. | Hosted CI proved Windows/Linux package identity, but no artifact has yet been uploaded to or downloaded from the Chrome Web Store for comparison. | Publish the release SHA-256, upload that exact ZIP, and compare it with the downloaded Web Store artifact. |
| 7 | Real-network warm-cache, cold-cache, signed-out, and slow-auth reveal timing may differ from fixtures. | The reveal state machine is fixture-tested, but network and production-render timing were not measured. | Capture those scenarios on current BGG with the same reveal, filtering, and blocked-content-flash metrics before setting tighter production budgets. |

## Stop condition

The merged audit is complete for repository code, controlled fixtures, local
release tooling, and hosted cross-platform CI. The maintainer retains release
ownership: create and sign off the release artifact and SHA-256, upload the
exact artifact, and compare the downloaded store bytes. Live authenticated API
and current-markup compatibility, precise memory behavior, real rate limiting,
release publication, and store-artifact provenance remain explicit validation
work; none is claimed as verified here.
