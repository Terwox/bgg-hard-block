| recommendation | model suggested to use | model effort to use |

> **Consumed — closed 2026-09-10.** Every row from this plan was carried into
> `AUDIT_RESULTS.md` and recorded there as Implemented. This file is kept as the
> record of what was planned, not as outstanding work. Live residual risks are in
> `AUDIT_RESULTS.md` under "Remaining hypotheses and residual risks"; note it was
> scoped against 0.3.15 while the extension is now 0.4.6.

|---|---|---|
| Map security, privacy, build, store, manifest, source, and test claims to their implementing code and existing coverage before making findings; use the map to prevent duplicate recommendations. | gpt-5.6-luna | medium |
| Adversarially audit `src/page-bridge.js` to prove the captured `GeekAuth` authorization header cannot reach published payloads, storage, the Document Object Model, logs, error messages, or any network destination other than the intended BGG API. | gpt-5.6-sol | xhigh |
| Threat-model the page-to-extension metadata and CustomEvent bridges against forged settings and data payloads; determine whether hostile BGG page code could alter persisted state, censor arbitrary users, expose data, or trigger privileged network writes. | gpt-5.6-sol | xhigh |
| Verify consent enforcement across installation, startup, mixed extension versions, withdrawal, and reinjection; confirm every disclosure-version copy agrees and already-installed fetch or XMLHttpRequest wrappers become inert when consent is absent. | gpt-5.6-sol | high |
| Audit subscription-block reconciliation and pagination handling for the additions-only invariant, trustworthy user identifiers, redirect behavior, origin pinning, protocol-relative URLs, Unicode host tricks, and unintended network destinations. | gpt-5.6-sol | high |
| Test username, profile-link, quote, and BBCode matchers against encoding, locale casing, homoglyphs, malformed nesting, attacker-sized input, bypasses, false matches, and regular-expression denial of service. | gpt-5.6-sol | high |
| Sweep all extension surfaces for script and markup injection sinks, then verify that popup, options, onboarding, and status rendering place BGG-derived values only into safe text contexts. | gpt-5.6-luna | medium |
| Audit manifest permissions, content-script patterns, background URL checks, service-worker injection, storage privileges, and single-page-application reinjection; prove the independent URL representations accept and reject the same intended pages. | gpt-5.6-terra | high |
| Audit browser and Python helper scripts for authenticated-session handling, cookie or credential leakage, subprocess safety, log redaction, fixture contamination, and cleanup behavior. | gpt-5.6-terra | medium |
| Benchmark the MutationObserver and DOM-filtering pipeline on realistic 500-plus-post threads; measure mutation-burst work, full-document sweeps, repeated blocked-set construction, overlapping selector scans, memory, and route-change behavior before proposing optimizations. | gpt-5.6-terra | high |
| Measure first-paint and reveal latency on warm-cache, cold-cache, signed-out, storage-failure, and delayed-bridge visits; evaluate the JavaScript hold and Cascading Style Sheets failsafe without weakening blocked-content concealment. | gpt-5.6-terra | high |
| Measure cold-cache profile resolution with large block lists; assess unbounded request fan-out, rate limits, latency, cancellation, caching, and whether bounded concurrency or an available batch endpoint would improve behavior. | gpt-5.6-terra | high |
| Review the content and bridge modules for human readability, focusing on mutable reveal-state flags, race handling, naming, control flow, duplication, and comment accuracy; recommend behavior-preserving boundaries compatible with the no-build, directly verifiable source policy. | gpt-5.6-terra | high |
| Enumerate every extension-storage and origin-storage write, then reconcile actual retention and data flow with privacy and security claims, including the assertion that reply drafts and authorization data are never persisted. | gpt-5.6-terra | high |
| Check README, build documentation, store listing, onboarding, options, and security guidance for feature drift, stale screenshots or instructions, unexplained terminology, and claims that cannot be traced to code or tests. | gpt-5.6-terra | medium |
| Audit continuous-integration dependencies, deterministic packaging, shipped-file boundaries, release hashes, artifact provenance, and Web Store verification assumptions; assess commit-SHA pinning and verify generated ZIP files remain excluded rather than assuming they are tracked. | gpt-5.6-terra | high |
| Produce a gap-driven regression plan covering adversarial bridge payloads, consent bypasses, origin escapes, storage failures, mixed-version behavior, malformed content, large DOM workloads, network fan-out, and explicit performance budgets; do not implement tests during the audit. | gpt-5.6-sol | high |
| Merge and deduplicate the completed audit outputs, separating verified findings from hypotheses and ranking recommendations by security impact, evidence strength, readability benefit, measured speed benefit, regression risk, and implementation cost. | gpt-5.6-terra | high |
