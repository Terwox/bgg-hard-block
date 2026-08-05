"use strict";

const CONSENT_KEY = "bggHardBlockerConsent";
const DISCLOSURE_VERSION = "2026-08-04";

function hasCurrentConsent(consent) {
  return consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(CONSENT_KEY);
  if (hasCurrentConsent(stored?.[CONSENT_KEY])) {
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding.html") });
});
