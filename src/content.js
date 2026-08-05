(async function runBggHardBlocker() {
  "use strict";

  const core = globalThis.BggHardBlockerCore;
  const CONSENT_KEY = "bggHardBlockerConsent";
  // Unpacked Chrome can read newer source before its manifest is reloaded.
  const LOADED_EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "";
  const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-04"
    : "2026-08-05";
  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const STORAGE_KEY = "bggHardBlockerState";
  const READY_ATTRIBUTE = "data-bgg-hard-blocker-ready";
  const RUNNING_ATTRIBUTE = "data-bgg-hard-blocker-running";
  const FILTERABLE_SELECTOR = "gg-post, article.post, gg-markup-quote";
  const POST_LOAD_MAX_HOLD_MS = 500;

  if (!core || !document.documentElement) {
    return;
  }

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
  let allowReveal = false;
  let cacheSettled = false;
  let domReady = document.readyState !== "loading";
  let hiddenPosts = 0;
  let hiddenQuotes = 0;
  let revealDeadlineTimer = 0;
  let statusWriteTimer = 0;
  let source = "waiting";
  let lastSync = null;
  let unresolved = 0;

  function filter(root = document) {
    const result = core.filterDom(root, blockedUsernames);
    hiddenPosts += result.posts;
    hiddenQuotes += result.quotes;

    if (result.posts || result.quotes) {
      scheduleStatusWrite();
    }
  }

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

  function scheduleStatusWrite() {
    if (statusWriteTimer) {
      return;
    }
    statusWriteTimer = window.setTimeout(writeStatus, 50);
  }

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
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["content", "data-username", "href", "ngbtooltip"],
    characterData: true,
    childList: true,
    subtree: true
  });

  if (globalThis.chrome?.storage?.local?.get) {
    chrome.storage.local
      .get(STORAGE_KEY)
      .then((stored) => {
        const cached = stored?.[STORAGE_KEY];
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
        if (source === "sync-error") {
          allowReveal = true;
        }
        revealIfReady();
      });
  } else {
    cacheSettled = true;
  }

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
