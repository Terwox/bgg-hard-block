(function bridgeBggHardBlockerSettings() {
  "use strict";

  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const CONSENT_KEY = "bggHardBlockerConsent";
  // Unpacked Chrome can read newer source before its manifest is reloaded.
  const LOADED_EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "";
  const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-04"
    : "2026-08-05";
  const OPTIONS_KEY = "bggHardBlockerOptions";
  const SETTINGS_ELEMENT_ID = "bgg-hard-blocker-settings";
  const SETTINGS_EVENT = "bgg-hard-blocker:settings";
  const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";

  if (!document.documentElement) {
    return;
  }

  let consentGranted = false;
  let linkSubscriptionBlocks = false;

  function publish(storageAvailable = true) {
    let element = document.getElementById(SETTINGS_ELEMENT_ID);
    if (!element) {
      element = document.createElement("meta");
      element.id = SETTINGS_ELEMENT_ID;
      element.setAttribute("name", SETTINGS_ELEMENT_ID);
      document.documentElement.appendChild(element);
    }

    element.setAttribute(
      "content",
      JSON.stringify({ consentGranted, linkSubscriptionBlocks, storageAvailable })
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
    if (!consentGranted || !subscriptionLinking || !globalThis.chrome?.storage?.local?.set) {
      return;
    }

    chrome.storage.local.set({
      [SUBSCRIPTION_STATE_KEY]: {
        ...subscriptionLinking,
        updatedAt: new Date().toISOString()
      }
    });
  }

  function hasCurrentConsent(consent) {
    return consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
  }

  async function loadSettings() {
    if (!globalThis.chrome?.storage?.local?.get) {
      publish(false);
      return;
    }

    try {
      const stored = await chrome.storage.local.get([CONSENT_KEY, OPTIONS_KEY]);
      consentGranted = hasCurrentConsent(stored?.[CONSENT_KEY]);
      const options = stored?.[OPTIONS_KEY];
      linkSubscriptionBlocks = consentGranted && options?.linkSubscriptionBlocks !== false;
      publish();
    } catch (_error) {
      consentGranted = false;
      linkSubscriptionBlocks = false;
      publish(false);
    }
  }

  document.addEventListener(DATA_EVENT, storeSubscriptionState);

  if (globalThis.chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || (!changes[CONSENT_KEY] && !changes[OPTIONS_KEY])) {
        return;
      }
      loadSettings();
    });
  }

  loadSettings();
  storeSubscriptionState();
})();
