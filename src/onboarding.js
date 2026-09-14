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

  // Firefox MV3 treats `host_permissions` as optional: they are shown at
  // install, but the user can revoke them from about:addons at any time, so the
  // extension can be consented-to and still unable to read BGG.
  const origins = ["https://boardgamegeek.com/*", "https://api.geekdo.com/*"];
  // Declared before the listener is registered so a click can never observe it
  // in the temporal dead zone; resolved at page load, further down.
  let hasHostAccess = true;

  agree.addEventListener("click", async () => {
    // Disable first: the storage write is async, and a double click would
    // otherwise record consent twice and re-trigger the tab refresh.
    agree.disabled = true;

    // Gecko clears its user-input flag on the microtask after the listener
    // returns, so nothing may be awaited before `permissions.request` — the
    // access state was therefore resolved at page load, below. Chrome reaches
    // the request branch only when the user has restricted site access ("On
    // click" or "On specific sites" in the extension menu), which withholds the
    // declared `host_permissions` so `contains` reports false; Chrome allows a
    // withheld *declared* origin to be re-requested, and the gate then behaves
    // exactly as it does on Firefox — request inside the gesture, fail closed if
    // the answer is still no. The trailing `contains` closes the window where
    // access was revoked between page load and click.
    if (chrome.permissions?.contains) {
      if (!hasHostAccess) {
        try { await chrome.permissions.request({ origins }); } catch { /* not a grant */ }
      }
      try {
        hasHostAccess = await chrome.permissions.contains({ origins });
      } catch {
        // A thrown check is not a grant; fail closed.
        hasHostAccess = false;
      }

      if (!hasHostAccess) {
        // Never leave a consent record the extension cannot act on.
        status.textContent =
          "BGG Hard Block needs access to boardgamegeek.com and api.geekdo.com. " +
          "Grant it in your browser's add-on settings, then click again.";
        agree.disabled = false;
        return;
      }
    }

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

  // Resolved here, at page load, so the click handler can reach
  // `permissions.request` without awaiting anything first.
  if (chrome.permissions?.contains) {
    try {
      hasHostAccess = await chrome.permissions.contains({ origins });
    } catch {
      hasHostAccess = false;
    }
  }

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
