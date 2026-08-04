(async function renderPopup() {
  "use strict";

  const STORAGE_KEY = "bggHardBlockerState";
  const elements = {
    blocked: document.getElementById("blocked-count"),
    posts: document.getElementById("post-count"),
    quotes: document.getElementById("quote-count"),
    state: document.getElementById("state")
  };

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = stored?.[STORAGE_KEY];
  const status = state?.status;

  if (!status) {
    return;
  }

  elements.blocked.textContent = String(status.blockedCount ?? 0);
  elements.posts.textContent = String(status.hiddenPosts ?? 0);
  elements.quotes.textContent = String(status.hiddenQuotes ?? 0);

  const labels = {
    cache: "Using the cached BGG block list",
    live: "Synced with the BGG block list",
    "storage-error": "Filtering without saved state",
    "sync-error": "BGG sync failed; cached filtering remains active",
    timeout: "BGG sync timed out",
    waiting: "Waiting for BGG"
  };
  elements.state.textContent = labels[status.source] || "Active on BGG forums";
})();
