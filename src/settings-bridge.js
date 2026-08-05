(function bridgeBggHardBlockerSettings() {
  "use strict";

  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const OPTIONS_KEY = "bggHardBlockerOptions";
  const SETTINGS_ELEMENT_ID = "bgg-hard-blocker-settings";
  const SETTINGS_EVENT = "bgg-hard-blocker:settings";
  const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";

  if (!document.documentElement) {
    return;
  }

  function publish(linkSubscriptionBlocks, storageAvailable = true) {
    let element = document.getElementById(SETTINGS_ELEMENT_ID);
    if (!element) {
      element = document.createElement("meta");
      element.id = SETTINGS_ELEMENT_ID;
      element.setAttribute("name", SETTINGS_ELEMENT_ID);
      document.documentElement.appendChild(element);
    }

    element.setAttribute(
      "content",
      JSON.stringify({ linkSubscriptionBlocks, storageAvailable })
    );
    document.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
  }

  function readBlockListPayload() {
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

  function storeSubscriptionState() {
    const subscriptionLinking = readBlockListPayload()?.subscriptionLinking;
    if (!subscriptionLinking || !globalThis.chrome?.storage?.local?.set) {
      return;
    }

    chrome.storage.local.set({
      [SUBSCRIPTION_STATE_KEY]: {
        ...subscriptionLinking,
        updatedAt: new Date().toISOString()
      }
    });
  }

  async function loadOptions() {
    if (!globalThis.chrome?.storage?.local?.get) {
      publish(false, false);
      return;
    }

    try {
      const stored = await chrome.storage.local.get(OPTIONS_KEY);
      const options = stored?.[OPTIONS_KEY];
      publish(options?.linkSubscriptionBlocks !== false);
    } catch (_error) {
      // A stored opt-out must never be bypassed if extension storage is unavailable.
      publish(false, false);
    }
  }

  document.addEventListener(DATA_EVENT, storeSubscriptionState);

  if (globalThis.chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[OPTIONS_KEY]) {
        return;
      }

      publish(changes[OPTIONS_KEY].newValue?.linkSubscriptionBlocks !== false);
    });
  }

  loadOptions();
  storeSubscriptionState();
})();
