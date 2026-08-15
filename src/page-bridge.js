// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

/**
 * Observe one BGG authorization value in MAIN world and return it privately.
 *
 * `background.js` injects this function only after validating the exact sending
 * document and current consent. Chrome returns the result directly to the
 * service worker through `chrome.scripting.executeScript`; the value never
 * enters the DOM, an event, extension storage, a log, or the isolated content
 * script. The service worker, not this page-controlled realm, performs and
 * validates every authenticated API request.
 *
 * The wrappers also emit a nonce-scoped revocation event when an exact native
 * user-block mutation starts, and refresh after a successful mutation. The
 * event carries no credential, ID, destination, or authorization to write; a
 * hostile page can at worst defer optional subscription linking. The wrappers
 * hold no authorization after the initial result is delivered.
 */
async function installBggBlockListBridge(configuration) {
  "use strict";

  configuration = configuration || {};

  const INSTALLATION_KEY = "__bggHardBlockerPageBridgeInstalled";
  const STOP_KEY = "__bggHardBlockerStop";
  const API_ORIGIN = "https://api.geekdo.com";
  const AUTH_PREFIX = "GeekAuth ";
  const AUTHORIZATION_WAIT_MS = 4000;
  const LEGACY_PROFILE_CACHE_KEY = "bgg-hard-blocker-profile-cache-v1";
  const channelNonce = String(configuration.channelNonce || "");
  if (!/^[a-f0-9]{32}$/.test(channelNonce)) {
    return { status: "error", reason: "invalid-configuration" };
  }
  const MUTATION_EVENT = `bgg-hard-blocker:native-userblock-mutation:${channelNonce}`;

  const supportedPage = (() => {
    try {
      const pageUrl = new URL(location.href);
      if (configuration.allowFileFixture === true) {
        return true;
      }
      return (
        pageUrl.origin === "https://boardgamegeek.com" &&
        !pageUrl.username &&
        !pageUrl.password &&
        [
          /^\/forum\//,
          /^\/thread\//,
          /^\/geeklist\//,
          /^\/image\//,
          /^\/video\//,
          /^\/filepage\//,
          /^\/blog\/[^/]+\/blogpost\//
        ].some((pattern) => pattern.test(pageUrl.pathname))
      );
    } catch (_error) {
      return false;
    }
  })();
  if (!supportedPage) {
    return { status: "error", reason: "unsupported-page" };
  }

  // v0.3.x cached derived profile mappings in BGG-origin storage. The current
  // cache is extension-owned; remove the obsolete page-writable copy.
  try {
    localStorage.removeItem(LEGACY_PROFILE_CACHE_KEY);
  } catch (_error) {
    // Site storage is never required for capture or filtering.
  }

  if (globalThis[INSTALLATION_KEY]) {
    if (typeof globalThis[STOP_KEY] !== "function") {
      return { status: "error", reason: "already-installed" };
    }
    globalThis[STOP_KEY]();
  }

  if (
    typeof window.fetch !== "function" ||
    typeof XMLHttpRequest === "undefined" ||
    typeof XMLHttpRequest.prototype?.open !== "function" ||
    typeof XMLHttpRequest.prototype?.setRequestHeader !== "function" ||
    typeof XMLHttpRequest.prototype?.send !== "function"
  ) {
    return { status: "error", reason: "bridge-unavailable" };
  }

  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const xhrMetadata = new WeakMap();

  let active = true;
  let reloadTimer = 0;
  let resultSettled = false;
  let resultTimer = 0;
  let settleResult = null;

  function normalizeApiUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      const inApiTree = url.pathname === "/api" || url.pathname.startsWith("/api/");
      return (
        url.protocol === "https:" &&
        url.origin === API_ORIGIN &&
        !url.username &&
        !url.password &&
        inApiTree
      )
        ? url
        : null;
    } catch (_error) {
      return null;
    }
  }

  function isUserBlockUrl(value) {
    const url = normalizeApiUrl(value);
    return Boolean(url && url.pathname === "/api/userblock" && !url.search);
  }

  function normalizeAuthorization(value) {
    if (
      typeof value !== "string" ||
      value.length <= AUTH_PREFIX.length ||
      value.length > 8192 ||
      !value.startsWith(AUTH_PREFIX) ||
      /[^\x20-\x7e]/.test(value)
    ) {
      return "";
    }
    return value;
  }

  function finish(result) {
    if (resultSettled) {
      return;
    }
    resultSettled = true;
    window.clearTimeout(resultTimer);
    // Header capture is one-shot. Keep the fetch/XHR mutation observers, but
    // immediately remove the XHR header hook and make fetch header inspection
    // inert so later page requests are never read for authorization values.
    if (XMLHttpRequest.prototype.setRequestHeader === patchedXhrSetRequestHeader) {
      XMLHttpRequest.prototype.setRequestHeader = originalXhrSetRequestHeader;
    }
    const resolve = settleResult;
    settleResult = null;
    resolve?.(result);
  }

  function captureAuthorization(name, value, requestUrl) {
    if (
      !active ||
      resultSettled ||
      !normalizeApiUrl(requestUrl) ||
      String(name || "").toLowerCase() !== "authorization"
    ) {
      return;
    }
    const authorization = normalizeAuthorization(value);
    if (authorization) {
      finish({ status: "ready", authorization });
    }
  }

  function inspectHeaders(headers, requestUrl) {
    if (resultSettled || !headers || !normalizeApiUrl(requestUrl)) {
      return;
    }
    try {
      if (typeof headers.get === "function") {
        captureAuthorization("authorization", headers.get("authorization"), requestUrl);
        return;
      }
      if (typeof headers[Symbol.iterator] === "function") {
        for (const entry of headers) {
          if (Array.isArray(entry) && entry.length >= 2) {
            captureAuthorization(entry[0], entry[1], requestUrl);
          }
        }
        return;
      }
      if (typeof headers === "object") {
        for (const [name, value] of Object.entries(headers)) {
          captureAuthorization(name, value, requestUrl);
        }
      }
    } catch (_error) {
      // Invalid native-request headers remain the page request's responsibility.
    }
  }

  function stopBggHardBlockerBridge() {
    if (!active) {
      return;
    }
    active = false;
    window.clearTimeout(reloadTimer);
    if (window.fetch === patchedFetch) {
      window.fetch = originalFetch;
    }
    if (XMLHttpRequest.prototype.open === patchedXhrOpen) {
      XMLHttpRequest.prototype.open = originalXhrOpen;
    }
    if (XMLHttpRequest.prototype.setRequestHeader === patchedXhrSetRequestHeader) {
      XMLHttpRequest.prototype.setRequestHeader = originalXhrSetRequestHeader;
    }
    if (XMLHttpRequest.prototype.send === patchedXhrSend) {
      XMLHttpRequest.prototype.send = originalXhrSend;
    }
    globalThis[INSTALLATION_KEY] = false;
    finish({ status: "error", reason: "cancelled" });
  }

  function requestReload() {
    if (!active || reloadTimer) {
      return;
    }
    // Give BGG's own mutation handler time to settle before tearing down the page.
    reloadTimer = window.setTimeout(() => {
      if (!active) {
        return;
      }
      stopBggHardBlockerBridge();
      location.reload();
    }, 100);
  }

  function patchedXhrOpen(method, url, ...rest) {
    xhrMetadata.set(this, {
      method: String(method || "GET").toUpperCase(),
      url: String(url || "")
    });
    this.addEventListener(
      "loadend",
      () => {
        const metadata = xhrMetadata.get(this);
        if (
          active &&
          metadata &&
          isUserBlockUrl(metadata.url) &&
          metadata.method !== "GET" &&
          this.status >= 200 &&
          this.status < 300
        ) {
          requestReload();
        }
      },
      { once: true }
    );
    return originalXhrOpen.call(this, method, url, ...rest);
  }

  function patchedXhrSetRequestHeader(name, value) {
    captureAuthorization(name, value, xhrMetadata.get(this)?.url);
    return originalXhrSetRequestHeader.call(this, name, value);
  }

  function revokeOptionalLinking() {
    document.dispatchEvent(new CustomEvent(MUTATION_EVENT));
  }

  function patchedXhrSend(...args) {
    const metadata = xhrMetadata.get(this);
    if (active && metadata && isUserBlockUrl(metadata.url) && metadata.method !== "GET") {
      revokeOptionalLinking();
    }
    return originalXhrSend.apply(this, args);
  }

  function patchedFetch(input, init) {
    const requestUrl = typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || input || "");
    if (!resultSettled) {
      inspectHeaders(input?.headers, requestUrl);
      inspectHeaders(init?.headers, requestUrl);
    }

    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (active && isUserBlockUrl(requestUrl) && method !== "GET") {
      revokeOptionalLinking();
    }
    const request = originalFetch.call(window, input, init);
    if (active && isUserBlockUrl(requestUrl) && method !== "GET") {
      Promise.resolve(request)
        .then((response) => {
          if (response?.ok) {
            requestReload();
          }
        })
        .catch(() => {});
    }
    return request;
  }

  globalThis[STOP_KEY] = stopBggHardBlockerBridge;
  globalThis[INSTALLATION_KEY] = true;
  XMLHttpRequest.prototype.open = patchedXhrOpen;
  XMLHttpRequest.prototype.setRequestHeader = patchedXhrSetRequestHeader;
  XMLHttpRequest.prototype.send = patchedXhrSend;
  window.fetch = patchedFetch;

  // This block gives the credential-bearing result its own lexical environment.
  // Long-lived mutation-only wrappers were created outside it and therefore do
  // not retain the returned authorization binding after this function returns.
  {
    const result = await new Promise((resolve) => {
      settleResult = resolve;
      resultTimer = window.setTimeout(() => {
        finish({ status: "error", reason: "authorization-unavailable" });
      }, AUTHORIZATION_WAIT_MS);
    });

    if (result.status !== "ready") {
      stopBggHardBlockerBridge();
    }
    return result;
  }
}
