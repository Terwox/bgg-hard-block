(async function renderPopup() {
  "use strict";

  const CONSENT_KEY = "bggHardBlockerConsent";
  const DISCLOSURE_VERSION = "2026-08-04";
  const STORAGE_KEY = "bggHardBlockerState";
  const OPTIONS_KEY = "bggHardBlockerOptions";
  const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";
  const elements = {
    blocked: document.getElementById("blocked-count"),
    options: document.getElementById("open-options"),
    posts: document.getElementById("post-count"),
    quotes: document.getElementById("quote-count"),
    state: document.getElementById("state"),
    subscription: document.getElementById("subscription-state"),
    subscriptionNote: document.getElementById("subscription-note")
  };

  const stored = await chrome.storage.local.get([
    CONSENT_KEY,
    STORAGE_KEY,
    OPTIONS_KEY,
    SUBSCRIPTION_STATE_KEY
  ]);
  const state = stored?.[STORAGE_KEY];
  const status = state?.status;
  const consent = stored?.[CONSENT_KEY];
  const consentGranted =
    consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
  const linkingEnabled = stored?.[OPTIONS_KEY]?.linkSubscriptionBlocks !== false;
  const subscription = stored?.[SUBSCRIPTION_STATE_KEY];

  elements.options.addEventListener("click", () => {
    if (consentGranted) {
      chrome.runtime.openOptionsPage();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding.html") });
    }
  });

  if (!consentGranted) {
    elements.state.textContent = "Setup required";
    elements.subscription.textContent = "Off";
    elements.subscriptionNote.textContent = "No BGG data is processed until you agree.";
    elements.options.textContent = "Complete setup";
    return;
  }

  if (!linkingEnabled) {
    elements.subscription.textContent = "Off";
    elements.subscriptionNote.textContent = "Existing BGG subscription blocks are unchanged.";
  } else if (subscription?.state === "synced") {
    elements.subscription.textContent = "On";
    elements.subscriptionNote.textContent =
      `${subscription.subscriptionBlockedCount || 0} of ${subscription.hiddenCount || 0} hidden users linked.`;
  } else if (subscription?.state === "partial") {
    elements.subscription.textContent = "Partial";
    elements.subscriptionNote.textContent =
      `${subscription.failedCount || 0} hidden users could not be linked.`;
  } else if (subscription?.state === "error") {
    elements.subscription.textContent = "Error";
    elements.subscriptionNote.textContent = "Latest linking attempt failed; forum blocking is still active.";
  } else if (subscription?.state === "syncing") {
    elements.subscription.textContent = "Syncing";
    elements.subscriptionNote.textContent = "Linking hidden users to subscription blocks…";
  }

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
