(function runBggHardBlocker() {
  "use strict";

  const core = globalThis.BggHardBlockerCore;
  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const STORAGE_KEY = "bggHardBlockerState";
  const READY_ATTRIBUTE = "data-bgg-hard-blocker-ready";
  const REVEAL_TIMEOUT_MS = 5000;

  if (!core || !document.documentElement) {
    return;
  }

  let blockedUsernames = new Set();
  let hasBlockList = false;
  let allowReveal = false;
  let cacheSettled = false;
  let domReady = document.readyState !== "loading";
  let hiddenPosts = 0;
  let hiddenQuotes = 0;
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

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          filter(node);
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

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
      },
      { once: true }
    );
  } else {
    filter(document);
    revealIfReady();
  }

  window.setTimeout(() => {
    if (!document.documentElement.hasAttribute(READY_ATTRIBUTE)) {
      source = hasBlockList ? source : "timeout";
      allowReveal = true;
      reveal();
    }
  }, REVEAL_TIMEOUT_MS);
})();
