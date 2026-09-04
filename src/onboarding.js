// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * Onboarding page: the affirmative consent gate.
 *
 * This page is the only place a consent record is created. Until the user
 * clicks **Agree**, the content scripts return early at their consent checks,
 * the MAIN-world bridge never installs its interceptors, and no BGG data is read.
 *
 * `background.js` opens this page on install, and again after an update whose
 * disclosure version differs from the one the user previously accepted.
 *
 * The subscription-linking checkbox is presented here rather than buried in
 * options because enabling it causes writes to the user's BGG account. It is
 * checked by default, and that default is disclosed in the page text next to it.
 */
(async function runOnboarding() {
  "use strict";

  const CONSENT_KEY = "bggHardBlockerConsent";

  // Disclosure-version ladder — see the longer explanation in src/content.js.
  // The value written below must match what the content scripts expect, or the
  // user would agree here and still find the extension inert.
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

  const OPTIONS_KEY = "bggHardBlockerOptions";
  const agree = document.getElementById("agree");
  const linking = document.getElementById("link-subscription-blocks");
  const status = document.getElementById("status");

  agree.addEventListener("click", async () => {
    // Disable first: the storage write is async, and a double click would
    // otherwise record consent twice and re-trigger the tab refresh.
    agree.disabled = true;

    // Consent and the linking choice are written together, so the extension can
    // never be active with an unrecorded preference. `grantedAt` exists so a
    // user can see when they agreed; it is never transmitted.
    await chrome.storage.local.set({
      [CONSENT_KEY]: {
        granted: true,
        disclosureVersion: DISCLOSURE_VERSION,
        grantedAt: new Date().toISOString()
      },
      [OPTIONS_KEY]: {
        linkSubscriptionBlocks: linking.checked
      }
    });

    // background.js observes this storage change and hard-refreshes open BGG
    // discussion tabs; this text tells the user that is happening.
    status.textContent = "Enabled. Open BGG discussion tabs are refreshing now.";
    agree.textContent = "BGG Hard Block is enabled";
  });

  const stored = await chrome.storage.local.get([CONSENT_KEY, OPTIONS_KEY]);

  // Preserve a previous opt-out when this page is shown again for a new
  // disclosure version, so re-consenting does not silently re-enable linking.
  if (stored?.[OPTIONS_KEY]?.linkSubscriptionBlocks === false) {
    linking.checked = false;
  }

  // Reaching this page with current consent means the user navigated here
  // manually; show the settled state rather than inviting a redundant click.
  const consent = stored?.[CONSENT_KEY];
  if (consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION) {
    status.textContent = "BGG Hard Block is already enabled.";
    agree.textContent = "BGG Hard Block is enabled";
    agree.disabled = true;
  }
})();
