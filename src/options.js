// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * Options page: the subscription-linking toggle and its sync status.
 *
 * There is exactly one setting. Filtering itself is not configurable, and there
 * is deliberately no "show anyway" override — the point of the extension is that
 * blocked content does not reach the page at all.
 *
 * ## The one-way rule
 *
 * Turning linking off stops *future* additions. It does not remove subscription
 * blocks BGG has already stored, because the extension cannot distinguish blocks
 * it added from blocks the user set themselves, and deleting the latter would be
 * destructive. Every status string below is worded to make that explicit rather
 * than letting the user assume "off" means "undone".
 */
(async function runOptionsPage() {
  "use strict";

  const CONSENT_KEY = "bggHardBlockerConsent";

  // Disclosure-version ladder — see the longer explanation in src/content.js.
  const LOADED_EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "";
  const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-04"
    : /^0\.3\.[3-5]$/.test(LOADED_EXTENSION_VERSION)
      ? "2026-08-05"
      : /^0\.3\.(?:[6-9]|1[0-2])$/.test(LOADED_EXTENSION_VERSION)
        ? "2026-08-06"
        : "2026-08-10";

  const OPTIONS_KEY = "bggHardBlockerOptions";
  const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";
  const checkbox = document.getElementById("link-subscription-blocks");
  const completeSetup = document.getElementById("complete-setup");
  const saveStatus = document.getElementById("save-status");
  const syncStatus = document.getElementById("sync-status");

  /**
   * Turn the stored sync state into a sentence.
   *
   * The state values originate in `reconcileSubscriptionBlocks` in
   * `src/page-bridge.js`. Note that `error` explicitly reassures the user that
   * discussion blocking still works — a failed link is a degraded convenience,
   * not a failure of the core feature, and the wording should not cause alarm.
   */
  function describeSync(state) {
    if (!state) {
      return "Linking will run the next time a signed-in BGG page is opened.";
    }

    if (state.enabled === false) {
      return "Subscription linking is off.";
    }

    const labels = {
      error: "The latest subscription sync failed; discussion blocking is still active.",
      partial: `Linked ${state.addedCount || 0}; ${state.failedCount || 0} could not be linked.`,
      synced: `${state.subscriptionBlockedCount || 0} of ${state.hiddenCount || 0} hidden users are subscription-blocked.`,
      syncing: "Linking hidden users to subscription blocks…",
      waiting: "Waiting for a signed-in BGG request."
    };
    return labels[state.state] || "Subscription linking is enabled.";
  }

  /** Render the current consent state, toggle position, and sync status. */
  async function render() {
    const stored = await chrome.storage.local.get([
      CONSENT_KEY,
      OPTIONS_KEY,
      SUBSCRIPTION_STATE_KEY
    ]);
    const consent = stored?.[CONSENT_KEY];
    const consentGranted =
      consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;

    // Default-on, matching settings-bridge.js.
    checkbox.checked = stored?.[OPTIONS_KEY]?.linkSubscriptionBlocks !== false;
    // Without consent the toggle is inert: the extension is not running at all,
    // so letting the user adjust its settings would misrepresent the state.
    checkbox.disabled = !consentGranted;
    completeSetup.hidden = consentGranted;
    if (!consentGranted) {
      saveStatus.textContent = "Privacy setup is required before the extension handles BGG data.";
      syncStatus.textContent = "BGG Hard Block is inactive.";
      return;
    }

    const subscriptionState = stored?.[SUBSCRIPTION_STATE_KEY];
    // Distinguishes "linking is on but hasn't run yet" from "linking is off".
    // Without this the user would see a stale "off" message right after
    // enabling the option.
    syncStatus.textContent = checkbox.checked && subscriptionState?.enabled === false
      ? "Linking will run the next time a signed-in BGG page is opened."
      : describeSync(subscriptionState);
  }

  checkbox.addEventListener("change", async () => {
    await chrome.storage.local.set({
      [OPTIONS_KEY]: {
        linkSubscriptionBlocks: checkbox.checked
      }
    });

    // "Future linking is off" and "were left unchanged" are load-bearing
    // phrasing — see the one-way rule in this file's header.
    saveStatus.textContent = checkbox.checked
      ? "Saved. Linking is on."
      : "Saved. Future linking is off.";
    syncStatus.textContent = checkbox.checked
      ? "Linking will run on the next signed-in BGG page."
      : "Existing BGG subscription blocks were left unchanged.";
  });

  completeSetup.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding.html") });
  });

  // Live updates: consent may be granted in another tab, and sync state is
  // written by the settings bridge while a BGG page is open.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[CONSENT_KEY]) {
      render();
    } else if (areaName === "local" && changes[SUBSCRIPTION_STATE_KEY]) {
      syncStatus.textContent = describeSync(changes[SUBSCRIPTION_STATE_KEY].newValue);
    }
  });

  await render();
})();
