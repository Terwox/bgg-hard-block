// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * Service worker: handles the two cases the declarative manifest cannot.
 *
 *   1. **In-page route changes.** BGG's Angular frontend can navigate from one
 *      discussion to another without loading a new document. Chrome's
 *      declarative `content_scripts` matching only runs on document load, so
 *      those routes would otherwise never get a filter attached. This worker
 *      watches for the URL change and injects the same three script worlds by
 *      hand.
 *   2. **Refresh-on-consent.** When the user agrees on the onboarding page,
 *      already-open BGG tabs are running content scripts that returned early at
 *      the consent gate. They are hard-reloaded so filtering starts at once
 *      rather than on the user's next manual refresh.
 *
 * ## Permission note
 *
 * This file is the reason the extension requests `scripting` — Chrome's
 * warning-free injection permission — rather than `tabs` or `webNavigation`,
 * either of which would grant broad browsing-history visibility. `chrome.tabs`
 * methods are used, but only the ones available without the `tabs` permission,
 * and `chrome.tabs.query` here is constrained by `DISCUSSION_TAB_PATTERNS` to
 * the same BGG discussion URLs the manifest already covers.
 */
"use strict";

const CONSENT_KEY = "bggHardBlockerConsent";

// Disclosure-version ladder — see the longer explanation in src/content.js.
// An unpacked extension can read newer source files before Chrome reloads its
// manifest. Honor the disclosure paired with the manifest Chrome actually loaded.
const LOADED_EXTENSION_VERSION = chrome.runtime.getManifest?.().version || "";
const DISCLOSURE_VERSION = /^0\.3\.[0-2]$/.test(LOADED_EXTENSION_VERSION)
  ? "2026-08-04"
  : /^0\.3\.[3-5]$/.test(LOADED_EXTENSION_VERSION)
    ? "2026-08-05"
    : /^0\.3\.(?:[6-9]|1[0-2])$/.test(LOADED_EXTENSION_VERSION)
      ? "2026-08-06"
      : /^0\.3\.1[34]$/.test(LOADED_EXTENSION_VERSION)
        ? "2026-08-10"
        : "2026-08-13";

// Match-pattern form, for chrome.tabs.query. Kept deliberately identical to the
// `content_scripts[].matches` list in manifest.json — if you add a surface to
// one, add it to the other and to DISCUSSION_PATH_PATTERNS below.
const DISCUSSION_TAB_PATTERNS = [
  "https://boardgamegeek.com/forum/*",
  "https://boardgamegeek.com/thread/*",
  "https://boardgamegeek.com/geeklist/*",
  "https://boardgamegeek.com/image/*",
  "https://boardgamegeek.com/video/*",
  "https://boardgamegeek.com/filepage/*",
  "https://boardgamegeek.com/blog/*/blogpost/*"
];

// Regex form of the same list, for validating a single URL.
const DISCUSSION_PATH_PATTERNS = [
  /^\/forum\//,
  /^\/thread\//,
  /^\/geeklist\//,
  /^\/image\//,
  /^\/video\//,
  /^\/filepage\//,
  /^\/blog\/[^/]+\/blogpost\//
];

/**
 * Decide whether a URL is a supported BGG discussion page.
 *
 * Parsed with `URL` rather than matched as a string so that a lookalike host
 * (`boardgamegeek.com.example.com`) or a downgraded scheme cannot pass. Protocol
 * and hostname are checked exactly; only then is the path consulted.
 *
 * Chrome represents host permissions at origin granularity and ignores their
 * path component, so the extension details page names BoardGameGeek as a whole
 * even though injection is restricted to these paths. This function is where
 * that restriction is actually enforced.
 */
function isDiscussionUrl(urlText) {
  try {
    const url = new URL(urlText);
    return (
      url.protocol === "https:" &&
      url.hostname === "boardgamegeek.com" &&
      DISCUSSION_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))
    );
  } catch (_error) {
    // An unparseable URL is not a discussion page.
    return false;
  }
}

/** Consent must be both granted and tied to the current disclosure text. */
function hasCurrentConsent(consent) {
  return consent?.granted === true && consent?.disclosureVersion === DISCLOSURE_VERSION;
}

/**
 * Hard-reload every open BGG discussion tab.
 *
 * `bypassCache` matters: a normal reload can restore the page from the
 * back/forward cache with the pre-consent content script still attached, which
 * would leave the tab unfiltered.
 *
 * `allSettled` because one closed or unreloadable tab must not prevent the rest.
 */
async function hardRefreshDiscussionTabs() {
  const tabs = await chrome.tabs.query({ url: DISCUSSION_TAB_PATTERNS });
  const refreshes = tabs
    .filter((tab) => Number.isInteger(tab.id))
    .map((tab) => chrome.tabs.reload(tab.id, { bypassCache: true }));

  await Promise.allSettled(refreshes);
}

/**
 * Attach the filter to a tab that reached a discussion via in-page routing.
 *
 * Mirrors the manifest's declarative setup exactly — same files, same worlds,
 * same order — so a routed page behaves identically to a cold load. Order is
 * load-bearing:
 *
 *   1. CSS first, to suppress any already-rendered blocked content immediately.
 *   2. `page-bridge.js` into the MAIN world, where BGG's auth header is visible.
 *   3. The ISOLATED trio, with `content-core.js` before `content.js` because the
 *      latter reads `globalThis.BggHardBlockerCore` at startup.
 *
 * `frameIds: [0]` restricts injection to the top-level frame, so third-party
 * iframes embedded in a BGG page are never touched.
 */
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

// Only `changeInfo.url` is inspected, and only against the discussion allowlist.
// Every script guards against double installation, so a redundant injection on a
// cold load is harmless.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !isDiscussionUrl(changeInfo.url)) {
    return;
  }

  // Injection can legitimately fail on a tab that closed or navigated away
  // mid-flight; there is nothing useful to do about it.
  injectDiscussionScripts(tabId).catch(() => {});
});

// Refresh open tabs at the moment consent transitions from absent to granted.
// The old/new comparison keeps unrelated writes to the consent record — or a
// re-grant of consent that was already current — from triggering a reload storm.
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

// On install and on update: if consent is current, refresh open tabs so the new
// content scripts attach. Otherwise open the disclosure. A user updating from a
// version with different disclosure text lands on the onboarding page again by
// design — the ladder above makes their stored consent no longer current.
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(CONSENT_KEY);
  if (hasCurrentConsent(stored?.[CONSENT_KEY])) {
    await hardRefreshDiscussionTabs();
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding.html") });
});
