// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * Toolbar popup: a read-only status readout.
 *
 * Everything shown here is read from `chrome.storage.local`, written by the
 * content script or background worker during the last discussion-page sync.
 * The popup issues no network requests, sends no messages to content scripts,
 * and changes no state — its only interactive element opens Options or setup.
 *
 * All values are written with `textContent`, never `innerHTML`, so a username
 * from BGG cannot inject markup into extension UI.
 */
(async function renderPopup() {
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
        : /^0\.3\.1[34]$/.test(LOADED_EXTENSION_VERSION)
          ? "2026-08-10"
          : /^0\.3\.15$/.test(LOADED_EXTENSION_VERSION)
            ? "2026-08-13"
            : /^0\.4\.[0-3]$/.test(LOADED_EXTENSION_VERSION) || !LOADED_EXTENSION_VERSION
              ? "2026-08-15"
              : "2026-09-03";

  const STORAGE_KEY = "bggHardBlockerState";
  const OPTIONS_KEY = "bggHardBlockerOptions";
  const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";
  const elements = {
    blocked: document.getElementById("blocked-count"),
    names: document.getElementById("name-count"),
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
  // Default-on, matching onboarding.js and options.js.
  const linkingEnabled = stored?.[OPTIONS_KEY]?.linkSubscriptionBlocks !== false;
  const subscription = stored?.[SUBSCRIPTION_STATE_KEY];

  // Sends the user wherever is actually useful: options once set up, the
  // disclosure if they have not agreed yet.
  elements.options.addEventListener("click", () => {
    if (consentGranted) {
      chrome.runtime.openOptionsPage();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding.html") });
    }
  });

  // Pre-consent: report inactivity plainly and stop. Counts are deliberately
  // left blank rather than shown as zero, which would imply the extension had
  // looked at a page and found nothing.
  if (!consentGranted) {
    elements.state.textContent = "Setup required";
    elements.subscription.textContent = "Off";
    elements.subscriptionNote.textContent = "No BGG data is processed until you agree.";
    elements.options.textContent = "Complete setup";
    return;
  }

  // Subscription-linking summary. States originate in
  // reconcileSubscriptionBlocks in src/background.js.
  if (!linkingEnabled) {
    // Restates the one-way rule: switching off does not undo past linking.
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
  } else if (subscription?.state === "error" && subscription.deferred === true) {
    elements.subscription.textContent = "Paused";
    elements.subscriptionNote.textContent =
      "BGG’s native Hidden Users changed. Linking will retry on the next supported discussion page load.";
  } else if (subscription?.state === "error") {
    elements.subscription.textContent = "Error";
    elements.subscriptionNote.textContent = "Latest linking attempt failed; discussion blocking is still active.";
  } else if (subscription?.state === "syncing") {
    elements.subscription.textContent = "Syncing";
    elements.subscriptionNote.textContent = "Linking hidden users to subscription blocks…";
  }

  // No status yet means no discussion page has been visited since install.
  if (!status) {
    return;
  }

  elements.blocked.textContent = String(status.blockedCount ?? 0);
  elements.posts.textContent = String(status.hiddenPosts ?? 0);
  elements.quotes.textContent = String(status.hiddenQuotes ?? 0);
  elements.names.textContent = String(status.redactedProfileNames ?? 0);

  // Provenance of the block list used on the last page. Surfacing this matters:
  // "cache" and "timeout" mean the filter ran against a list that may be stale,
  // which the user should be able to see rather than having to infer.
  const labels = {
    cache: "Using the cached BGG block list",
    live: "Synced with the BGG block list",
    "storage-error": "Filtering without saved state",
    "sync-error": "BGG sync failed; cached filtering remains active",
    timeout: "BGG sync timed out",
    waiting: "Waiting for BGG"
  };
  elements.state.textContent = labels[status.source] || "Active on BGG discussions";
})();
