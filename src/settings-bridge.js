// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * ISOLATED-world settings bridge: the return channel to the MAIN world.
 *
 * `page-bridge.js` runs in the page's own JavaScript context and therefore has
 * no access to `chrome.storage`. It still needs to know two things before it may
 * do anything: whether the user has consented, and whether subscription linking
 * is enabled. This file reads both from extension storage and publishes them
 * into a `<meta>` element the MAIN world can read.
 *
 * It also handles the reverse direction for one specific value: the MAIN world's
 * subscription-linking status, which the popup and options page display but
 * cannot reach directly, is copied back into `chrome.storage.local` here.
 *
 * ## What crosses the boundary
 *
 *   ISOLATED → MAIN:  { consentGranted, linkSubscriptionBlocks, storageAvailable }
 *   MAIN → ISOLATED:  the `subscriptionLinking` block of the published payload
 *
 * Both are booleans and counters. No credentials cross in either direction; the
 * MAIN world's `authHeader` is never published. See the header of
 * `src/page-bridge.js`.
 *
 * ## Fail-closed
 *
 * Every error path sets `consentGranted = false`. If storage is unreadable, the
 * MAIN world is told there is no consent, which leaves its interceptors
 * uninstalled and the extension inert.
 */
(function bridgeBggHardBlockerSettings() {
  "use strict";

  const INSTALLATION_KEY = "__bggHardBlockerSettingsBridgeInstalled";
  if (globalThis[INSTALLATION_KEY]) {
    return;
  }

  const DATA_ELEMENT_ID = "bgg-hard-blocker-data";
  const DATA_EVENT = "bgg-hard-blocker:blocklist";
  const CONSENT_KEY = "bggHardBlockerConsent";

  // Disclosure-version ladder — see the longer explanation in src/content.js.
  // Unpacked Chrome can read newer source before its manifest is reloaded.
  const LOADED_EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "";
  const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-04"
    : /^0\.3\.[3-5]$/.test(LOADED_EXTENSION_VERSION)
      ? "2026-08-05"
      : /^0\.3\.(?:[6-9]|1[0-2])$/.test(LOADED_EXTENSION_VERSION)
        ? "2026-08-06"
        : /^0\.3\.1[34]$/.test(LOADED_EXTENSION_VERSION)
          ? "2026-08-10"
          : "2026-08-13";

  const OPTIONS_KEY = "bggHardBlockerOptions";
  const SETTINGS_ELEMENT_ID = "bgg-hard-blocker-settings";
  const SETTINGS_EVENT = "bgg-hard-blocker:settings";
  const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";

  if (!document.documentElement) {
    return;
  }
  globalThis[INSTALLATION_KEY] = true;

  let consentGranted = false;
  let linkSubscriptionBlocks = false;

  /**
   * Publish settings for the MAIN world.
   *
   * @param {boolean} storageAvailable False when `chrome.storage` could not be
   *   read at all, which the MAIN world treats the same as withheld consent.
   */
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

  /** Read the block-list payload the MAIN world published. */
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

  /**
   * Copy subscription-linking status into extension storage for the UI.
   *
   * Guarded on `consentGranted` so that a page which somehow published a payload
   * pre-consent cannot cause a write. Only the counters and state string are
   * stored — this payload never contains BGG content.
   */
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

  /** Consent must be both granted and tied to the current disclosure text. */
  function hasCurrentConsent(consent) {
    return consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
  }

  /**
   * Read consent and options, then publish.
   *
   * Note the default: `linkSubscriptionBlocks !== false` means linking is on
   * unless explicitly disabled. That matches the onboarding checkbox, which is
   * checked by default and whose state is written at the same moment consent is
   * recorded. Linking is still gated on `consentGranted`, so the default only
   * applies to users who already agreed.
   */
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
      // Fail closed: an unreadable store means the MAIN world stays inert.
      consentGranted = false;
      linkSubscriptionBlocks = false;
      publish(false);
    }
  }

  document.addEventListener(DATA_EVENT, storeSubscriptionState);

  // Re-publish when consent or options change, so toggling the option in the
  // options page takes effect on open BGG tabs without a reload.
  if (globalThis.chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || (!changes[CONSENT_KEY] && !changes[OPTIONS_KEY])) {
        return;
      }
      loadSettings();
    });
  }

  loadSettings();
  // The MAIN world may have published before this script attached.
  storeSubscriptionState();
})();
