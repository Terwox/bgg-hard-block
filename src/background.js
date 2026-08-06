"use strict";

const CONSENT_KEY = "bggHardBlockerConsent";
// An unpacked extension can read newer source files before Chrome reloads its
// manifest. Honor the disclosure paired with the manifest Chrome actually loaded.
const LOADED_EXTENSION_VERSION = chrome.runtime.getManifest?.().version || "";
const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
  ? "2026-08-04"
  : /^0\.3\.[3-5]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-05"
    : "2026-08-06";
const DISCUSSION_TAB_PATTERNS = [
  "https://boardgamegeek.com/thread/*",
  "https://boardgamegeek.com/geeklist/*",
  "https://boardgamegeek.com/image/*",
  "https://boardgamegeek.com/video/*",
  "https://boardgamegeek.com/filepage/*",
  "https://boardgamegeek.com/blog/*/blogpost/*"
];
const DISCUSSION_PATH_PATTERNS = [
  /^\/thread\//,
  /^\/geeklist\//,
  /^\/image\//,
  /^\/video\//,
  /^\/filepage\//,
  /^\/blog\/[^/]+\/blogpost\//
];

function isDiscussionUrl(urlText) {
  try {
    const url = new URL(urlText);
    return (
      url.protocol === "https:" &&
      url.hostname === "boardgamegeek.com" &&
      DISCUSSION_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))
    );
  } catch (_error) {
    return false;
  }
}

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

async function injectDiscussionScripts(tabId) {
  const target = { tabId, frameIds: [0] };

  // A BGG client-side route can enter /thread/... without loading a new
  // document, so declarative path matches never get another chance to attach.
  // Insert CSS first to suppress any already-rendered blocked content, then
  // install the same three script worlds used by the declarative cold-load path.
  await chrome.scripting.insertCSS({
    target,
    files: ["src/content.css"]
  });
  await chrome.scripting.executeScript({
    target,
    files: ["src/page-bridge.js"],
    world: "MAIN",
    injectImmediately: true
  });
  await chrome.scripting.executeScript({
    target,
    files: ["src/settings-bridge.js", "src/content-core.js", "src/content.js"],
    world: "ISOLATED",
    injectImmediately: true
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !isDiscussionUrl(changeInfo.url)) {
    return;
  }

  injectDiscussionScripts(tabId).catch(() => {});
});

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
