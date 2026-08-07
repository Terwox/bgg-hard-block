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
 *   - a live block list arrived from the MAIN-world bridge (best case)
 *   - the cached block list settled and the bridge reported an error
 *   - `POST_LOAD_MAX_HOLD_MS` elapsed after `DOMContentLoaded`
 *
 * ## Privacy note
 *
 * This script never sees the `GeekAuth` header. It receives only the published
 * block list — user IDs and public usernames — through a `<meta>` element. See
 * the header of `src/page-bridge.js` for the world boundary.
 */
(async function runBggHardBlocker() {
  "use strict";

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
  // ordinary releases. The same ladder appears in background.js,
  // settings-bridge.js, popup.js, options.js, and onboarding.js.
  const LOADED_EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "";
  const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-04"
    : /^0\.3\.[3-5]$/.test(LOADED_EXTENSION_VERSION)
      ? "2026-08-05"
      : "2026-08-06";

  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const STORAGE_KEY = "bggHardBlockerState";
  /** Set on <html> to release the CSS hide. */
  const READY_ATTRIBUTE = "data-bgg-hard-blocker-ready";
  /** Set on <html> purely so tests can assert the script attached. */
  const RUNNING_ATTRIBUTE = "data-bgg-hard-blocker-running";
  const FILTERABLE_SELECTOR = "gg-post, article.post, gg-markup-quote";
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

  if (!core || !document.documentElement) {
    return;
  }
  globalThis[INSTALLATION_KEY] = true;

  // ---------------------------------------------------------------------------
  // Consent gate. Nothing below this block runs without a current consent
  // record. Note that both the failure path and the refusal path still set
  // READY_ATTRIBUTE — declining consent must not leave BGG hidden.
  // ---------------------------------------------------------------------------
  try {
    const storedConsent = await chrome.storage.local.get(CONSENT_KEY);
    const consent = storedConsent?.[CONSENT_KEY];
    if (consent?.granted !== true || consent?.disclosureVersion !== DISCLOSURE_VERSION) {
      document.documentElement.setAttribute(READY_ATTRIBUTE, "");
      return;
    }
  } catch (_error) {
    document.documentElement.setAttribute(READY_ATTRIBUTE, "");
    return;
  }

  let blockedUsernames = new Set();
  let hasBlockList = false;
  /** Gate for reveal: set once a block list is trustworthy enough to show the page. */
  let allowReveal = false;
  /** Whether the cached-blocklist read has finished, successfully or not. */
  let cacheSettled = false;
  let domReady = document.readyState !== "loading";
  let hiddenPosts = 0;
  let hiddenQuotes = 0;
  let revealDeadlineTimer = 0;
  let statusWriteTimer = 0;
  /** Provenance of the current list; surfaced verbatim in the popup. */
  let source = "waiting";
  let lastSync = null;
  let unresolved = 0;

  /** Run the core filter over a subtree and accumulate counts. */
  function filter(root = document) {
    const result = core.filterDom(root, blockedUsernames);
    hiddenPosts += result.posts;
    hiddenQuotes += result.quotes;

    if (result.posts || result.quotes) {
      scheduleStatusWrite();
    }
  }

  /**
   * Filter once more, then release the CSS hide.
   *
   * The final `filter(document)` before revealing is the point of the whole
   * hold: it guarantees the first frame the user sees is already clean.
   */
  function reveal() {
    filter(document);
    document.documentElement.setAttribute(READY_ATTRIBUTE, "");
    scheduleStatusWrite();
  }

  function revealIfReady() {
    if (domReady && allowReveal) {
      reveal();
    }
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
      if (!document.documentElement.hasAttribute(READY_ATTRIBUTE)) {
        source = hasBlockList ? source : "timeout";
        allowReveal = true;
        reveal();
      }
    }, POST_LOAD_MAX_HOLD_MS);
  }

  /** Snapshot for the popup. Contains no BGG content and no credentials. */
  function currentStatus() {
    return {
      blockedCount: blockedUsernames.size,
      hiddenPosts,
      hiddenQuotes,
      lastSync,
      pageUrl: location.href,
      source,
      unresolved,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Persist the block list and counters.
   *
   * This is the complete set of what the extension stores. Auditors comparing
   * against the privacy disclosure should find nothing beyond `usernames` and
   * the status object above — no post bodies, no thread contents, no draft text.
   */
  function writeStatus() {
    statusWriteTimer = 0;
    if (globalThis.chrome?.storage?.local?.set) {
      chrome.storage.local.set({
        [STORAGE_KEY]: {
          usernames: [...blockedUsernames],
          status: currentStatus()
        }
      });
    }
  }

  /** Coalesce writes: a busy mutation burst otherwise hammers storage. */
  function scheduleStatusWrite() {
    if (statusWriteTimer) {
      return;
    }
    statusWriteTimer = window.setTimeout(writeStatus, 50);
  }

  /**
   * Adopt a block list from either the cache or the live bridge.
   *
   * Only a `"live"` list sets `allowReveal` on its own. A cached list filters
   * immediately but does not by itself end the hold, because a stale cache could
   * be missing a recently blocked user — that case is covered by the deadline
   * timer instead.
   *
   * @param {{usernames: string[], syncedAt?: string, unresolved?: unknown[]}} payload
   * @param {"cache"|"live"} nextSource
   */
  function applyBlockList(payload, nextSource) {
    if (!payload || !Array.isArray(payload.usernames)) {
      return false;
    }

    blockedUsernames = core.makeBlockedSet(payload.usernames);
    hasBlockList = true;
    source = nextSource;
    allowReveal ||= nextSource === "live";
    lastSync = payload.syncedAt || lastSync;
    unresolved = Array.isArray(payload.unresolved) ? payload.unresolved.length : 0;
    filter(document);
    revealIfReady();
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
  document.addEventListener(
    "click",
    (event) => {
      if (!isPostQuoteButton(event.target)) {
        return;
      }

      for (const delay of QUOTE_SANITIZE_DELAYS_MS) {
        window.setTimeout(sanitizeQuoteEditors, delay);
      }
    },
    true
  );

  /** Read the block list published by the MAIN-world bridge. */
  function readBridgePayload() {
    const element = document.getElementById(DATA_ELEMENT_ID);
    if (!element) {
      return null;
    }

    try {
      return JSON.parse(element.getAttribute("content") || "null");
    } catch (_error) {
      return null;
    }
  }

  /**
   * Handle a bridge publication.
   *
   * On error, reveal only once the cache read has settled — otherwise a fast
   * sync failure would show an unfiltered page while a perfectly good cached
   * list was still a millisecond away.
   */
  function acceptBridgePayload() {
    const payload = readBridgePayload();
    if (payload?.status === "ready") {
      applyBlockList(payload, "live");
    } else if (payload?.status === "error") {
      source = hasBlockList ? source : "sync-error";
      allowReveal = cacheSettled;
      revealIfReady();
      scheduleStatusWrite();
    }
  }

  document.addEventListener(DATA_EVENT, acceptBridgePayload);

  /**
   * Reduce a mutated node to the smallest subtree worth re-filtering.
   *
   * Re-filtering the whole document on every mutation would be quadratic on a
   * long thread. Text-node mutations resolve to their parent element, because a
   * quote's attribution often arrives as a text change inside existing markup.
   */
  function collectMutationRoot(node, roots) {
    const element =
      node?.nodeType === Node.ELEMENT_NODE
        ? node
        : node?.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : null;

    if (!element) {
      return;
    }

    const owner = element.closest(FILTERABLE_SELECTOR);
    if (owner) {
      roots.add(owner);
    } else if (element.querySelector(FILTERABLE_SELECTOR)) {
      roots.add(element);
    }
  }

  const observer = new MutationObserver((records) => {
    // Deduplicate first: one Angular render produces many records pointing at
    // the same post.
    const roots = new Set();

    for (const record of records) {
      collectMutationRoot(record.target, roots);
      for (const node of record.addedNodes) {
        collectMutationRoot(node, roots);
      }
    }

    for (const root of roots) {
      if (root.isConnected) {
        filter(root);
      }
    }
  });

  // Attribute filtering is narrow on purpose. These four are the attributes
  // that can change a filtering decision after a post is already in the DOM:
  // `content` (microdata author), `data-username` (quote author), `href`
  // (profile link hydration), and `ngbtooltip` (native blocked marker).
  // Watching all attributes would fire on every hover and animation frame.
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["content", "data-username", "href", "ngbtooltip"],
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
        const cached = stored?.[STORAGE_KEY];
        // Skip if a live list already arrived — never downgrade fresh to stale.
        if (!hasBlockList && Array.isArray(cached?.usernames)) {
          applyBlockList(
            {
              usernames: cached.usernames,
              syncedAt: cached.status?.lastSync,
              unresolved: []
            },
            "cache"
          );
        }
      })
      .catch(() => {
        source = "storage-error";
      })
      .finally(() => {
        cacheSettled = true;
        // A sync error that arrived before the cache settled deferred its
        // reveal to here.
        if (source === "sync-error") {
          allowReveal = true;
        }
        revealIfReady();
      });
  } else {
    cacheSettled = true;
  }

  // The bridge may have published before this script attached, so read once
  // directly instead of relying solely on the event.
  acceptBridgePayload();

  if (!domReady) {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        domReady = true;
        filter(document);
        revealIfReady();
        scheduleRevealDeadline();
      },
      { once: true }
    );
  } else {
    filter(document);
    revealIfReady();
    scheduleRevealDeadline();
  }

  document.documentElement.setAttribute(RUNNING_ATTRIBUTE, "");
})();
