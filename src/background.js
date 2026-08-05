"use strict";

const CONSENT_KEY = "bggHardBlockerConsent";
const DISCLOSURE_VERSION = "2026-08-04";
const FORUM_TAB_PATTERNS = [
  "*://boardgamegeek.com/forum/*",
  "*://boardgamegeek.com/forums*",
  "*://boardgamegeek.com/thread/*",
  "*://boardgamegeek.com/threads/*",
  "*://www.boardgamegeek.com/forum/*",
  "*://www.boardgamegeek.com/forums*",
  "*://www.boardgamegeek.com/thread/*",
  "*://www.boardgamegeek.com/threads/*"
];

function hasCurrentConsent(consent) {
  return consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
}

async function hardRefreshForumTabs() {
  const tabs = await chrome.tabs.query({ url: FORUM_TAB_PATTERNS });
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
    hardRefreshForumTabs().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(CONSENT_KEY);
  if (hasCurrentConsent(stored?.[CONSENT_KEY])) {
    await hardRefreshForumTabs();
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding.html") });
});
