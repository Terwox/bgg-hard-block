// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * ISOLATED-world content script: applies the filter and controls page reveal.
 *
 * ## Responsibilities
 *
 *   1. Refuse to do anything until consent is recorded and current.
 *   2. Hold the page visually hidden until the first filter pass completes, so
 *      blocked content never flashes onscreen.
 *   3. Apply `content-core.js` to the initial DOM and to everything BGG loads
 *      afterwards.
 *   4. Sanitise the reply draft when the user clicks **Quote**.
 *   5. Persist counts for the popup.
 *
 * ## The reveal problem
 *
 * `src/content.css` hides discussion content until this script sets
 * `data-bgg-hard-blocker-ready` on `<html>`. That is what prevents a flash of a
 * blocked post. But it means a bug here would leave BGG permanently blank, so
 * the reveal logic is deliberately over-cautious — there are three independent
 * paths to revealing, and the CSS itself carries a two-second failsafe that
 * un-hides the page even if this script never runs at all.
 *
 * Reveal happens when the DOM is ready **and** one of:
 *   - a live block list arrived from the background synchronization (best case)
 *   - the cached block list settled and the bridge reported an error
 *   - `POST_LOAD_MAX_HOLD_MS` elapsed after `DOMContentLoaded`
 *
 * ## Privacy note
 *
 * This script never sees the `GeekAuth` header or BGG user IDs. It accepts only
 * the public usernames, custom-avatar identifiers, and status returned through
 * extension messaging after
 * the background worker validates BGG's API response. No page-writable data
 * channel participates in filtering or persistence. See `src/background.js`
 * for that trust boundary.
 */
(async function runBggHardBlocker() {
  "use strict";

  function isDiscussionUrl(urlText) {
    try {
      const url = new URL(urlText);
      return url.origin === "https://boardgamegeek.com" && !url.username && !url.password && [
        /^\/forum\//, /^\/thread\//, /^\/geeklist\//, /^\/image\//, /^\/video\//,
        /^\/filepage\//, /^\/blog\/[^/]+\/blogpost\//, /^\/subscriptions\/?$/
      ].some((pattern) => pattern.test(url.pathname));
    } catch (_error) {
      return false;
    }
  }

  // Programmatic injection can finish after an SPA navigation has already
  // left discussion scope. Keep this check independent of the background's
  // route decision so that race never installs page behavior.
  if (globalThis.chrome?.runtime?.id && !isDiscussionUrl(location.href)) {
    document.documentElement?.setAttribute("data-bgg-hard-blocker-ready", "");
    return;
  }

  // Guard against double injection (declarative cold load + programmatic
  // injection after an in-page route change).
  const INSTALLATION_KEY = "__bggHardBlockerContentInstalled";
  if (globalThis[INSTALLATION_KEY]) {
    return;
  }

  const core = globalThis.BggHardBlockerCore;
  const CONSENT_KEY = "bggHardBlockerConsent";

  // Disclosure-version ladder. An unpacked or mid-update extension can execute
  // newer source files while Chrome still reports the older manifest, so the
  // disclosure honoured here is keyed to the manifest version Chrome actually
  // loaded. Bumping this string forces every user back through the consent
  // screen, so it changes only when the disclosure text itself changes — not on
  // ordinary releases. The same ladder appears in background.js, popup.js,
  // options.js, and onboarding.js.
  const LOADED_EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "";
  const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-04"
    : /^0\.3\.[3-5]$/.test(LOADED_EXTENSION_VERSION)
      ? "2026-08-05"
      : /^0\.3\.(?:[6-9]|1[0-2])$/.test(LOADED_EXTENSION_VERSION)
        ? "2026-08-06"
        : /^0\.3\.1[34]$/.test(LOADED_EXTENSION_VERSION)
          ? "2026-08-10"
          : /^0\.3\.15$/.test(LOADED_EXTENSION_VERSION)
            ? "2026-08-13"
            : /^0\.4\.[0-3]$/.test(LOADED_EXTENSION_VERSION) || !LOADED_EXTENSION_VERSION
              ? "2026-08-15"
              : "2026-09-03";

  const BRIDGE_MESSAGE_TYPE = "bgg-hard-blocker:initialize-bridge:v1";
  const STATUS_MESSAGE_TYPE = "bgg-hard-blocker:update-content-status:v1";
  const STORAGE_KEY = "bggHardBlockerState";
  const STATE_SCHEMA_VERSION = 2;
  const MAX_BLOCKED_USERS = 5000;
  /** Set on <html> to release the CSS hide. */
  const READY_ATTRIBUTE = "data-bgg-hard-blocker-ready";
  /** Set on <html> purely so tests can assert the script attached. */
  const RUNNING_ATTRIBUTE = "data-bgg-hard-blocker-running";
  /** Set on <html> once a usable block list makes per-item checks possible. */
  const QUARANTINE_ATTRIBUTE = "data-bgg-hard-blocker-quarantine";
  /** Set on author-bearing elements after their author has been inspected. */
  const CHECKED_ATTRIBUTE = "data-bgg-hard-blocker-checked";
  const POST_SELECTOR = "gg-post, article.post";
  const QUOTE_SELECTOR = "gg-markup-quote";
  const REDACTABLE_PROFILE_LINK_SELECTOR = [
    'gg-thread-listing a[href*="/profile/"]',
    'gg-reactions-list-popover gg-thumbs-list a[href*="/profile/"]'
  ].join(", ");
  const SUBSCRIPTION_IMAGE_SELECTOR = "gg-notice .item-image";
  const HIDDEN_SUBSCRIPTION_AVATAR_ATTRIBUTE =
    "data-bgg-hard-blocker-hidden-subscription-avatar";
  const FILTERABLE_SELECTOR = [
    POST_SELECTOR,
    QUOTE_SELECTOR,
    REDACTABLE_PROFILE_LINK_SELECTOR,
    SUBSCRIPTION_IMAGE_SELECTOR
  ].join(", ");
  const QUOTE_BUTTON_SELECTOR = "gg-post button.post-btn";
  const QUOTE_EDITOR_SELECTOR = "textarea.post-textarea[name=\"text\"]";

  // BGG populates the reply editor asynchronously and revises it more than once
  // after the click. Rather than guessing a single correct moment, sanitise at
  // each of these offsets; the operation is idempotent and cheap, and a missed
  // pass would mean a blocked user's text sitting in the user's own draft.
  const QUOTE_SANITIZE_DELAYS_MS = [0, 25, 100, 250, 500];

  // Upper bound on how long the page stays hidden waiting for a live sync.
  // Long enough for a typical authenticated round trip, short enough that a
  // failed sync is not perceived as a broken site.
  const POST_LOAD_MAX_HOLD_MS = 500;
  // Backstop for mutations that leave content not yet classifiable. Local
  // filtering still runs immediately; uncertain render bursts coalesce into
  // one whole-document verification pass.
  const FULL_SWEEP_DEBOUNCE_MS = 75;

  // The service worker invalidates a tab's capture state on every
  // `chrome.tabs.onUpdated` `status: "loading"`, because that is what a real
  // navigation looks like and an authorization must never be reused across
  // documents. BGG also fires a second `status: "loading"` with no URL change
  // roughly a second into a thread load, on a document that never went away —
  // measured at +949ms on boardgamegeek.com/thread/3760807 on 2026-08-31 —
  // which killed the in-flight session for a perfectly live document and
  // reported `stale-document` or `sync-cancelled`.
  //
  // Loosening the invalidation would weaken the boundary it exists to hold, so
  // this document simply asks again. A document that genuinely navigated away
  // has no content script left to retry, an SPA route change tears this scope
  // down before any retry can fire, and the service worker revalidates the tab
  // URL, the document, and consent from scratch on every attempt.
  const RETRYABLE_BRIDGE_REASONS = new Set(["stale-document", "sync-cancelled"]);
  // Long enough for BGG's own late authenticated requests to land — the
  // service worker holds an observed header for 5s — and bounded so an
  // endlessly invalidating tab cannot loop.
  const BRIDGE_RETRY_DELAYS_MS = [300, 900];

  if (!core || !document.documentElement) {
    return;
  }
  globalThis[INSTALLATION_KEY] = true;
  document.documentElement.removeAttribute(READY_ATTRIBUTE);

  let active = true;
  let observer = null;
  let domContentLoadedHandler = null;
  let revealDeadlineTimer = 0;
  let statusWriteTimer = 0;
  let fullSweepTimer = 0;
  let bridgeRetryTimer = 0;
  const filterRemovedNodes = new WeakSet();

  function ensureActiveScope() {
    if (active && globalThis.chrome?.runtime?.id && !isDiscussionUrl(location.href)) {
      stopContentScript();
    }
    return active;
  }

  function stopContentScript() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("click", quoteClickHandler, true);
    if (domContentLoadedHandler) {
      document.removeEventListener("DOMContentLoaded", domContentLoadedHandler);
    }
    window.clearTimeout(revealDeadlineTimer);
    window.clearTimeout(statusWriteTimer);
    window.clearTimeout(fullSweepTimer);
    window.clearTimeout(bridgeRetryTimer);

    document.querySelectorAll(`[${CHECKED_ATTRIBUTE}]`)
      .forEach((element) => element.removeAttribute(CHECKED_ATTRIBUTE));
    document.querySelectorAll("[data-bgg-hard-blocker-redacted]")
      .forEach((element) => element.removeAttribute("data-bgg-hard-blocker-redacted"));
    document.querySelectorAll(`[${HIDDEN_SUBSCRIPTION_AVATAR_ATTRIBUTE}]`)
      .forEach((element) => element.removeAttribute(HIDDEN_SUBSCRIPTION_AVATAR_ATTRIBUTE));
    for (const attribute of [RUNNING_ATTRIBUTE, QUARANTINE_ATTRIBUTE]) {
      document.documentElement.removeAttribute(attribute);
    }
    // Manifest-declared CSS cannot reliably be removed with scripting.removeCSS.
    // Leave the harmless reveal marker in place so that stylesheet cannot hide
    // an unsupported SPA route; a supported re-entry clears it before filtering.
    document.documentElement.setAttribute(READY_ATTRIBUTE, "");
    const stopMutationRelay = globalThis.__bggHardBlockerMutationRelay;
    if (typeof stopMutationRelay === "function") stopMutationRelay();
    delete globalThis.__bggHardBlockerMutationRelay;
    delete globalThis[INSTALLATION_KEY];
    delete globalThis.__bggHardBlockerContentStop;
  }

  globalThis.__bggHardBlockerContentStop = stopContentScript;

  // ---------------------------------------------------------------------------
  // Consent gate. Nothing below this block runs without a current consent
  // record. Note that both the failure path and the refusal path still set
  // READY_ATTRIBUTE — declining consent must not leave BGG hidden.
  // ---------------------------------------------------------------------------
  try {
    const storedConsent = await chrome.storage.local.get(CONSENT_KEY);
    if (!active || (globalThis.chrome?.runtime?.id && !isDiscussionUrl(location.href))) {
      stopContentScript();
      return;
    }
    const consent = storedConsent?.[CONSENT_KEY];
    if (consent?.granted !== true || consent?.disclosureVersion !== DISCLOSURE_VERSION) {
      document.documentElement.setAttribute(READY_ATTRIBUTE, "");
      return;
    }
  } catch (_error) {
    if (!active) return;
    document.documentElement.setAttribute(READY_ATTRIBUTE, "");
    return;
  }

  let blockedUsernames = core.makeBlockedSet([]);
  let blockedAvatarIds = new Set();
  let hasBlockList = false;
  let blockListRevision = 0;
  let documentFilteredRevision = -1;
  /** Explicit startup inputs keep reveal decisions independent of status text. */
  let bridgeState = "pending";
  let cacheState = globalThis.chrome?.storage?.local?.get
    ? "pending"
    : "unavailable";
  let revealAuthorized = false;
  let domReady = document.readyState !== "loading";
  let hiddenPosts = 0;
  let hiddenQuotes = 0;
  let redactedProfileNames = 0;
  /** Provenance of the current list; surfaced verbatim in the popup. */
  let source = "waiting";
  let lastSync = null;
  let unresolved = 0;

  const channelBytes = new Uint8Array(16);
  crypto.getRandomValues(channelBytes);
  const channelNonce = Array.from(
    channelBytes,
    (value) => value.toString(16).padStart(2, "0")
  ).join("");

  /** Collect matching descendants, including an element root itself. */
  function collectElements(root, selector) {
    const elements = [];
    if (root?.nodeType === Node.ELEMENT_NODE && root.matches(selector)) {
      elements.push(root);
    }
    if (typeof root?.querySelectorAll === "function") {
      elements.push(...root.querySelectorAll(selector));
    }
    return elements;
  }

  /** Resolve an article to the outer gg-post shell that must be released. */
  function canonicalPost(element) {
    return element.matches("gg-post")
      ? element
      : element.closest("gg-post") || element;
  }

  /**
   * Release only content whose author is known and allowed.
   *
   * Newly inserted posts and quotes start hidden by CSS. If BGG has not yet
   * hydrated enough markup to identify the author, the item stays quarantined
   * instead of being mistaken for safe. The next relevant mutation rechecks it.
   */
  function releaseInspectedContent(root) {
    if (!active || !hasBlockList) {
      return;
    }

    const posts = new Set(collectElements(root, POST_SELECTOR).map(canonicalPost));
    for (const post of posts) {
      if (!post.isConnected) {
        continue;
      }

      const author = core.postUsername(post);
      if (!author || blockedUsernames.has(author)) {
        continue;
      }

      post.setAttribute(CHECKED_ATTRIBUTE, "");
      const article = post.matches("article.post")
        ? post
        : post.querySelector(":scope > article.post");
      article?.setAttribute(CHECKED_ATTRIBUTE, "");
    }

    for (const quote of collectElements(root, QUOTE_SELECTOR)) {
      if (!quote.isConnected) {
        continue;
      }

      const author = core.quoteUsername(quote);
      if (
        (author && !blockedUsernames.has(author)) ||
        (!author && core.isReadyAnonymousQuote(quote))
      ) {
        quote.setAttribute(CHECKED_ATTRIBUTE, "");
      }
    }

    for (const link of collectElements(root, REDACTABLE_PROFILE_LINK_SELECTOR)) {
      const author = core.usernameFromProfileHref(link.getAttribute("href"));
      if (author && !blockedUsernames.has(author)) {
        link.setAttribute(CHECKED_ATTRIBUTE, "");
      }
    }

    for (const imageRegion of collectElements(root, SUBSCRIPTION_IMAGE_SELECTOR)) {
      const avatarId = core.subscriptionAvatarId(imageRegion);
      if (
        avatarId !== null &&
        (!avatarId || !blockedAvatarIds.has(avatarId) ||
          imageRegion.hasAttribute(HIDDEN_SUBSCRIPTION_AVATAR_ATTRIBUTE))
      ) {
        imageRegion.setAttribute(CHECKED_ATTRIBUTE, "");
      }
    }
  }

  /** Discard decisions made from attribution that a mutation may have changed. */
  function invalidateInspectedContent(root) {
    const posts = new Set(collectElements(root, POST_SELECTOR).map(canonicalPost));
    for (const post of posts) {
      post.removeAttribute(CHECKED_ATTRIBUTE);
      const article = post.matches("article.post")
        ? post
        : post.querySelector(":scope > article.post");
      article?.removeAttribute(CHECKED_ATTRIBUTE);
    }
    for (const quote of collectElements(root, QUOTE_SELECTOR)) {
      quote.removeAttribute(CHECKED_ATTRIBUTE);
    }
    for (const link of collectElements(root, REDACTABLE_PROFILE_LINK_SELECTOR)) {
      link.removeAttribute(CHECKED_ATTRIBUTE);
    }
    for (const imageRegion of collectElements(root, SUBSCRIPTION_IMAGE_SELECTOR)) {
      imageRegion.removeAttribute(CHECKED_ATTRIBUTE);
    }
  }

  function filterCandidates(root) {
    return new Set([
      ...collectElements(root, POST_SELECTOR).map(canonicalPost),
      ...collectElements(root, QUOTE_SELECTOR),
      ...collectElements(root, REDACTABLE_PROFILE_LINK_SELECTOR).map((link) =>
        link.closest("gg-avatar-popup-trigger, gg-username-link") || link
      ),
      ...collectElements(root, SUBSCRIPTION_IMAGE_SELECTOR)
    ]);
  }

  /** Run the core filter over a subtree and accumulate counts. */
  function filter(root = document) {
    if (!ensureActiveScope()) return;
    // Checked markers are cached allow decisions. Clear them before consulting
    // the current DOM so author removal or progressive hydration immediately
    // returns the affected surface to CSS quarantine until reclassification.
    // CHECKED_ATTRIBUTE is deliberately absent from the observer's attribute
    // filter, so these internal marker updates cannot create observer loops.
    invalidateInspectedContent(root);
    const candidates = filterCandidates(root);
    const result = core.filterDom(root, blockedUsernames, blockedAvatarIds);
    for (const node of candidates) {
      if (!node.isConnected) filterRemovedNodes.add(node);
    }
    hiddenPosts += result.posts;
    hiddenQuotes += result.quotes;
    redactedProfileNames += result.profileNames;
    releaseInspectedContent(root);
    if (root === document) {
      documentFilteredRevision = blockListRevision;
    }

    if (result.posts || result.quotes || result.profileNames || result.subscriptionAvatars) {
      scheduleStatusWrite();
    }
  }

  /** Release the CSS hide after the current block list has been applied. */
  function reveal() {
    if (!ensureActiveScope()) return;
    document.documentElement.setAttribute(READY_ATTRIBUTE, "");
    scheduleStatusWrite();
  }

  function revealIfReady() {
    if (!ensureActiveScope()) return;
    const currentListApplied =
      !hasBlockList || documentFilteredRevision === blockListRevision;
    if (
      domReady &&
      revealAuthorized &&
      currentListApplied &&
      !document.documentElement.hasAttribute(READY_ATTRIBUTE)
    ) {
      reveal();
    }
  }

  /** Recompute the reveal gate whenever cache or bridge state settles. */
  function updateRevealAuthorization() {
    if (!ensureActiveScope()) return;
    revealAuthorized ||=
      bridgeState === "ready" ||
      (bridgeState === "error" && cacheState !== "pending");
    revealIfReady();
  }

  /**
   * Last-resort reveal timer.
   *
   * If no block list has arrived by the deadline, show the page anyway. A page
   * that is briefly unfiltered is better than a page that never appears.
   */
  function scheduleRevealDeadline() {
    if (revealDeadlineTimer) {
      return;
    }

    revealDeadlineTimer = window.setTimeout(() => {
      if (!active) return;
      if (!document.documentElement.hasAttribute(READY_ATTRIBUTE)) {
        source = hasBlockList ? source : "timeout";
        revealAuthorized = true;
        reveal();
      }
    }, POST_LOAD_MAX_HOLD_MS);
  }

  /** Tab-local filtering counters. Contains no BGG content, canonical state, or credentials. */
  function currentPageCounters() {
    return {
      hiddenPosts,
      hiddenQuotes,
      redactedProfileNames,
      updatedAt: new Date().toISOString()
    };
  }

  /** Send tab-local counters to the background-owned canonical state record. */
  function writeStatus() {
    statusWriteTimer = 0;
    if (ensureActiveScope() && hasBlockList &&
        typeof globalThis.chrome?.runtime?.sendMessage === "function") {
      chrome.runtime.sendMessage({
        type: STATUS_MESSAGE_TYPE,
        channelNonce,
        status: currentPageCounters()
      }).catch(() => {});
    }
  }

  /** Coalesce writes: a busy mutation burst otherwise hammers storage. */
  function scheduleStatusWrite() {
    if (!ensureActiveScope() || !hasBlockList || statusWriteTimer) {
      return;
    }
    statusWriteTimer = window.setTimeout(writeStatus, 50);
  }

  /**
   * Adopt a block list from extension storage or the private background result.
   *
   * Only a `"live"` list sets `allowReveal` on its own. A cached list filters
   * immediately but does not by itself end the hold, because a stale cache could
   * be missing a recently blocked user — that case is covered by the deadline
   * timer instead.
   *
   * @param {{usernames: string[], avatarIds?: string[], syncedAt?: string, unresolvedCount?: number,
   *   unresolved?: unknown[]}} payload
   * @param {"cache"|"live"} nextSource
   */
  function applyBlockList(payload, nextSource) {
    if (!ensureActiveScope() || !payload || !Array.isArray(payload.usernames)) {
      return false;
    }

    blockedUsernames = core.makeBlockedSet(payload.usernames);
    blockedAvatarIds = new Set(
      Array.isArray(payload.avatarIds)
        ? payload.avatarIds.filter((value) =>
          typeof value === "string" &&
          /^avatar_(?:id)?[1-9]\d{0,15}\.(?:gif|jpe?g|png|webp)$/.test(value)
        ).map((value) => value.toLocaleLowerCase("en-US"))
        : []
    );
    hasBlockList = true;
    blockListRevision += 1;
    source = nextSource;
    lastSync = payload.syncedAt || lastSync;
    unresolved = Number.isInteger(payload.unresolvedCount)
      ? payload.unresolvedCount
      : Array.isArray(payload.unresolved)
        ? payload.unresolved.length
        : 0;
    filter(document);
    // The filter above marks all currently inspectable allowed items before
    // enabling CSS quarantine, so a late live sync cannot blank a visible page.
    document.documentElement.setAttribute(QUARANTINE_ATTRIBUTE, "");
    updateRevealAuthorization();
    scheduleStatusWrite();
    return true;
  }

  /**
   * Write to a textarea in a way Angular notices.
   *
   * Assigning `.value` directly is invisible to frameworks that track the native
   * property descriptor, so BGG would keep its own unsanitised copy of the
   * draft. Calling the prototype setter and then dispatching a bubbling `input`
   * event mimics a real edit, which is what makes BGG adopt the sanitised text.
   */
  function setTextareaValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (setter) {
      setter.call(textarea, value);
    } else {
      textarea.value = value;
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /**
   * Strip blocked quotes from any open reply editor.
   *
   * Idempotent — if nothing changed, no event is dispatched, so this can safely
   * run at each of `QUOTE_SANITIZE_DELAYS_MS`. Draft text is processed in memory
   * and never stored.
   */
  function sanitizeQuoteEditors() {
    if (!ensureActiveScope()) return;
    for (const textarea of document.querySelectorAll(QUOTE_EDITOR_SELECTOR)) {
      const sanitized = core.sanitizeBlockedQuotes(textarea.value, blockedUsernames);
      if (sanitized !== textarea.value) {
        setTextareaValue(textarea, sanitized);
      }
    }
  }

  /**
   * Identify BGG's **Quote** button.
   *
   * The label check matters: `.post-btn` also covers Reply, Flag, and others,
   * and only Quote injects BBCode into the editor.
   */
  function isPostQuoteButton(target) {
    const button = target?.nodeType === Node.ELEMENT_NODE
      ? target.closest?.("button")
      : target?.parentElement?.closest?.("button");

    return Boolean(
      button?.matches(QUOTE_BUTTON_SELECTOR) &&
      (button.textContent || button.innerText || "").trim() === "Quote"
    );
  }

  // Capture phase, so this runs before BGG's own click handler and the timers
  // below are already scheduled by the time BGG fills the editor.
  function quoteClickHandler(event) {
    if (!ensureActiveScope() || !isPostQuoteButton(event.target)) return;
    for (const delay of QUOTE_SANITIZE_DELAYS_MS) {
      window.setTimeout(sanitizeQuoteEditors, delay);
    }
  }

  document.addEventListener("click", quoteClickHandler, true);

  function sanitizeUsernames(value) {
    if (!Array.isArray(value) || value.length > MAX_BLOCKED_USERS) return null;
    const usernames = [];
    for (const rawUsername of value) {
      if (
        typeof rawUsername !== "string" ||
        !rawUsername.trim() ||
        rawUsername.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(rawUsername)
      ) {
        return null;
      }
      usernames.push(rawUsername.trim());
    }
    return usernames;
  }

  function sanitizeBlockListPayload(payload) {
    const usernames = sanitizeUsernames(payload?.usernames);
    const avatarIds = payload?.avatarIds === undefined
      ? []
      : Array.isArray(payload.avatarIds) &&
          payload.avatarIds.length <= MAX_BLOCKED_USERS &&
          payload.avatarIds.every((value) => typeof value === "string" &&
            /^avatar_(?:id)?[1-9]\d{0,15}\.(?:gif|jpe?g|png|webp)$/i.test(value))
        ? [...new Set(payload.avatarIds.map((value) => value.toLocaleLowerCase("en-US")))]
        : null;
    if (
      payload?.status !== "ready" ||
      !usernames ||
      !avatarIds ||
      !Number.isInteger(payload.unresolvedCount) ||
      payload.unresolvedCount < 0 ||
      payload.unresolvedCount > MAX_BLOCKED_USERS ||
      typeof payload.syncedAt !== "string" ||
      !Number.isFinite(Date.parse(payload.syncedAt))
    ) {
      return null;
    }

    return {
      status: "ready",
      usernames,
      avatarIds,
      unresolvedCount: payload.unresolvedCount,
      syncedAt: payload.syncedAt
    };
  }

  function acceptBridgeError() {
    if (!ensureActiveScope()) return;
    bridgeState = "error";
    source = hasBlockList ? source : "sync-error";
    updateRevealAuthorization();
    scheduleStatusWrite();
  }

  function acceptPrivateBridgePayload(rawPayload) {
    if (!ensureActiveScope()) return;
    const payload = sanitizeBlockListPayload(rawPayload);
    if (!payload) {
      acceptBridgeError();
      return;
    }

    bridgeState = "ready";
    applyBlockList(payload, "live");
  }

  /**
   * Ask the service worker for a live sync, retrying the invalidation races
   * that a still-current document can lose. See RETRYABLE_BRIDGE_REASONS.
   */
  function requestBridgeSync(attempt) {
    chrome.runtime
      .sendMessage({ type: BRIDGE_MESSAGE_TYPE, channelNonce })
      .then((payload) => {
        if (!active) return;
        if (payload?.status === "ready") {
          acceptPrivateBridgePayload(payload);
          return;
        }
        if (attempt < BRIDGE_RETRY_DELAYS_MS.length &&
            RETRYABLE_BRIDGE_REASONS.has(payload?.reason)) {
          bridgeRetryTimer = window.setTimeout(() => {
            bridgeRetryTimer = 0;
            if (!ensureActiveScope()) return;
            requestBridgeSync(attempt + 1);
          }, BRIDGE_RETRY_DELAYS_MS[attempt]);
          return;
        }
        acceptBridgeError();
      })
      .catch(acceptBridgeError);
  }

  /**
   * Reduce a mutated node to the smallest subtree worth re-filtering.
   *
   * Re-filtering the whole document on every mutation would be quadratic on a
   * long thread. Text-node mutations resolve to their parent element, because a
   * quote's attribution often arrives as a text change inside existing markup.
   */
  function collectMutationRoot(node, roots, includeDescendants) {
    const element =
      node?.nodeType === Node.ELEMENT_NODE
        ? node
        : node?.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : null;

    if (!element) {
      return;
    }

    const root = element.closest(FILTERABLE_SELECTOR) ||
      (includeDescendants && element.querySelector(FILTERABLE_SELECTOR) ? element : null);
    if (!root) {
      return;
    }

    // Keep only the broadest necessary roots. Mutation batches commonly
    // contain both an inserted post and several descendants hydrated inside it.
    for (const existing of roots) {
      if (existing === root || existing.contains(root)) {
        return;
      }
      if (root.contains(existing)) {
        roots.delete(existing);
      }
    }
    roots.add(root);
  }

  /** Whether a filtered subtree still contains content awaiting attribution. */
  function hasUnclassifiedContent(root) {
    return collectElements(root, FILTERABLE_SELECTOR).some((element) => {
      const candidate = element.matches(POST_SELECTOR)
        ? canonicalPost(element)
        : element;
      return candidate.isConnected && !candidate.hasAttribute(CHECKED_ATTRIBUTE);
    });
  }

  /** Verify the full page once an Angular render burst settles. */
  function scheduleFullSweep() {
    window.clearTimeout(fullSweepTimer);
    fullSweepTimer = window.setTimeout(() => {
      fullSweepTimer = 0;
      filter(document);
    }, FULL_SWEEP_DEBOUNCE_MS);
  }

  observer = new MutationObserver((records) => {
    if (!ensureActiveScope()) return;
    // Deduplicate first: one Angular render produces many records pointing at
    // the same post.
    const roots = new Set();

    for (const record of records) {
      // For child insertions, the added nodes are the narrowest useful roots.
      // Including their parent would turn one lazy-loaded post into a rescan of
      // the entire thread feed. Attribute/character-data records have no added
      // subtree, so their target remains the correct starting point.
      if (record.type !== "childList") {
        collectMutationRoot(record.target, roots, false);
      } else if (record.removedNodes.length && !record.addedNodes.length) {
        const removedByFilter = [...record.removedNodes]
          .every((node) => filterRemovedNodes.has(node));
        for (const node of record.removedNodes) filterRemovedNodes.delete(node);
        if (!removedByFilter) collectMutationRoot(record.target, roots, false);
      }
      for (const node of record.addedNodes) {
        collectMutationRoot(node, roots, true);
      }
    }

    for (const root of roots) {
      if (root.isConnected) {
        filter(root);
      }
    }

    // Most mutations are either unrelated to filterable content or completely
    // classified by the targeted passes above. Reserve the expensive fallback
    // for incomplete markup whose author may arrive in a later render step.
    if ([...roots].some((root) => root.isConnected && hasUnclassifiedContent(root))) {
      scheduleFullSweep();
    }
  });

  // Attribute filtering is narrow on purpose. These are the attributes that
  // can change a filtering decision after a post is already in the DOM:
  // `content`/`itemprop` (microdata author), `data-username` (quote author),
  // `src`/`srcset` (subscription portrait hydration),
  // `href` (profile/reaction link hydration), `ngbtooltip` (native blocked
  // marker), and `class` (Angular turning a generic shell into filterable
  // markup).
  // Watching all attributes would fire on every hover and animation frame.
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "class",
      "content",
      "data-username",
      "href",
      "itemprop",
      "ngbtooltip",
      "src",
      "srcset"
    ],
    characterData: true,
    childList: true,
    subtree: true
  });

  // Load the cached block list. This usually wins the race against the network
  // and is what makes filtering feel instant on a warm profile.
  if (globalThis.chrome?.storage?.local?.get) {
    chrome.storage.local
      .get(STORAGE_KEY)
      .then((stored) => {
        if (!active) return;
        const cached = stored?.[STORAGE_KEY];
        const cachedUsernames = sanitizeUsernames(cached?.usernames);
        const cachedLastSync = cached?.status?.lastSync;
        const validLastSync = cachedLastSync === undefined ||
          (typeof cachedLastSync === "string" && Number.isFinite(Date.parse(cachedLastSync)));
        const cachedAvatarIds = Array.isArray(cached?.avatarIds) &&
          cached.avatarIds.length <= MAX_BLOCKED_USERS &&
          cached.avatarIds.every((value) => typeof value === "string" &&
            /^avatar_(?:id)?[1-9]\d{0,15}\.(?:gif|jpe?g|png|webp)$/.test(value))
          ? cached.avatarIds
          : null;
        if (!hasBlockList && cached?.schemaVersion === STATE_SCHEMA_VERSION &&
            cachedUsernames && cachedAvatarIds && validLastSync) {
          applyBlockList(
            {
              usernames: cachedUsernames,
              avatarIds: cachedAvatarIds,
              syncedAt: cachedLastSync,
              unresolved: []
            },
            "cache"
          );
        }
      })
      .catch(() => {
        if (!active) return;
        source = "storage-error";
        cacheState = "error";
      })
      .finally(() => {
        if (!active) return;
        if (cacheState === "pending") {
          cacheState = "ready";
        }
        updateRevealAuthorization();
      });
  } else {
    updateRevealAuthorization();
  }

  if (typeof globalThis.chrome?.runtime?.sendMessage === "function") {
    requestBridgeSync(0);
  }

  if (!domReady) {
    domContentLoadedHandler = () => {
      if (!active) return;
      domReady = true;
      filter(document);
      updateRevealAuthorization();
      scheduleRevealDeadline();
    };
    document.addEventListener("DOMContentLoaded", domContentLoadedHandler, { once: true });
  } else {
    if (documentFilteredRevision !== blockListRevision) {
      filter(document);
    }
    updateRevealAuthorization();
    scheduleRevealDeadline();
  }

  document.documentElement.setAttribute(RUNNING_ATTRIBUTE, "");
})();
