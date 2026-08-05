(async function runOptionsPage() {
  "use strict";

  const CONSENT_KEY = "bggHardBlockerConsent";
  const DISCLOSURE_VERSION = "2026-08-05";
  const OPTIONS_KEY = "bggHardBlockerOptions";
  const SUBSCRIPTION_STATE_KEY = "bggHardBlockerSubscriptionState";
  const checkbox = document.getElementById("link-subscription-blocks");
  const completeSetup = document.getElementById("complete-setup");
  const saveStatus = document.getElementById("save-status");
  const syncStatus = document.getElementById("sync-status");

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

  async function render() {
    const stored = await chrome.storage.local.get([
      CONSENT_KEY,
      OPTIONS_KEY,
      SUBSCRIPTION_STATE_KEY
    ]);
    const consent = stored?.[CONSENT_KEY];
    const consentGranted =
      consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
    checkbox.checked = stored?.[OPTIONS_KEY]?.linkSubscriptionBlocks !== false;
    checkbox.disabled = !consentGranted;
    completeSetup.hidden = consentGranted;
    if (!consentGranted) {
      saveStatus.textContent = "Privacy setup is required before the extension handles BGG data.";
      syncStatus.textContent = "BGG Hard Block is inactive.";
      return;
    }
    const subscriptionState = stored?.[SUBSCRIPTION_STATE_KEY];
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

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[CONSENT_KEY]) {
      render();
    } else if (areaName === "local" && changes[SUBSCRIPTION_STATE_KEY]) {
      syncStatus.textContent = describeSync(changes[SUBSCRIPTION_STATE_KEY].newValue);
    }
  });

  await render();
})();
