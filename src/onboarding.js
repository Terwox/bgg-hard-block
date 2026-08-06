(async function runOnboarding() {
  "use strict";

  const CONSENT_KEY = "bggHardBlockerConsent";
  const LOADED_EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "";
  const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-04"
    : /^0\.3\.[3-5]$/.test(LOADED_EXTENSION_VERSION)
      ? "2026-08-05"
      : "2026-08-06";
  const OPTIONS_KEY = "bggHardBlockerOptions";
  const agree = document.getElementById("agree");
  const linking = document.getElementById("link-subscription-blocks");
  const status = document.getElementById("status");

  agree.addEventListener("click", async () => {
    agree.disabled = true;
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
    status.textContent = "Enabled. Open BGG discussion tabs are refreshing now.";
    agree.textContent = "BGG Hard Block is enabled";
  });

  const stored = await chrome.storage.local.get([CONSENT_KEY, OPTIONS_KEY]);
  if (stored?.[OPTIONS_KEY]?.linkSubscriptionBlocks === false) {
    linking.checked = false;
  }

  const consent = stored?.[CONSENT_KEY];
  if (consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION) {
    status.textContent = "BGG Hard Block is already enabled.";
    agree.textContent = "BGG Hard Block is enabled";
    agree.disabled = true;
  }
})();
