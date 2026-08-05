"use strict";

const CONSENT_KEY = "bggHardBlockerConsent";
const DISCLOSURE_VERSION = "2026-08-05";
const DISCUSSION_TAB_PATTERNS = [
  "https://boardgamegeek.com/thread/*",
  "https://boardgamegeek.com/geeklist/*",
  "https://boardgamegeek.com/image/*",
  "https://boardgamegeek.com/video/*",
  "https://boardgamegeek.com/filepage/*",
  "https://boardgamegeek.com/blog/*/blogpost/*"
];

function hasCurrentConsent(consent) {
  return consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
}

async function hardRefreshDiscussionTabs() {
  const tabs = await chrome.tabs.query({ url: DISCUSSION_TAB_PATTERNS });
  const refreshes = tabs
    .filter((tab) => Number.isInteger(tab.id))
    .map((tab) => chrome.tabs.reload(tab.id, { bypassCache: true }));

  await Promise.allSettled(refreshes);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  const consentChange = changes[CONSENT_KEY];
  if (
    !hasCurrentConsent(consentChange?.oldValue) &&
    hasCurrentConsent(consentChange?.newValue)
  ) {
    hardRefreshDiscussionTabs().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(CONSENT_KEY);
  if (hasCurrentConsent(stored?.[CONSENT_KEY])) {
    await hardRefreshDiscussionTabs();
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding.html") });
});
