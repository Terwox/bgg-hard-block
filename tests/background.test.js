"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const listeners = {};
const createdTabs = [];
const queries = [];
const reloads = [];
let storedConsent;

globalThis.chrome = {
  runtime: {
    getURL(relativePath) {
      return `chrome-extension://test/${relativePath}`;
    },
    onInstalled: {
      addListener(listener) {
        listeners.installed = listener;
      }
    }
  },
  storage: {
    local: {
      async get() {
        return { bggHardBlockerConsent: storedConsent };
      }
    },
    onChanged: {
      addListener(listener) {
        listeners.storageChanged = listener;
      }
    }
  },
  tabs: {
    async create(options) {
      createdTabs.push(options);
    },
    async query(options) {
      queries.push(options);
      return [{ id: 7 }, { id: 11 }, { id: undefined }];
    },
    async reload(tabId, options) {
      reloads.push({ tabId, options });
    }
  }
};

require(path.join(__dirname, "..", "src", "background.js"));

const currentConsent = {
  granted: true,
  disclosureVersion: "2026-08-04"
};

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

(async () => {
  assert.equal(typeof listeners.installed, "function");
  assert.equal(typeof listeners.storageChanged, "function");

  storedConsent = undefined;
  await listeners.installed();
  assert.deepEqual(createdTabs, [
    { url: "chrome-extension://test/src/onboarding.html" }
  ]);

  storedConsent = currentConsent;
  await listeners.installed();
  assert.equal(createdTabs.length, 1, "onboarding reopened despite current consent");
  assert.equal(queries.length, 1, "enabled update did not refresh forum tabs");
  assert.deepEqual(reloads, [
    { tabId: 7, options: { bypassCache: true } },
    { tabId: 11, options: { bypassCache: true } }
  ]);

  queries.length = 0;
  reloads.length = 0;

  listeners.storageChanged(
    {
      bggHardBlockerConsent: {
        oldValue: undefined,
        newValue: currentConsent
      }
    },
    "local"
  );
  await settle();

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].url, [
    "*://boardgamegeek.com/forum/*",
    "*://boardgamegeek.com/forums*",
    "*://boardgamegeek.com/thread/*",
    "*://boardgamegeek.com/threads/*",
    "*://www.boardgamegeek.com/forum/*",
    "*://www.boardgamegeek.com/forums*",
    "*://www.boardgamegeek.com/thread/*",
    "*://www.boardgamegeek.com/threads/*"
  ]);
  assert.deepEqual(reloads, [
    { tabId: 7, options: { bypassCache: true } },
    { tabId: 11, options: { bypassCache: true } }
  ]);

  listeners.storageChanged(
    {
      bggHardBlockerConsent: {
        oldValue: currentConsent,
        newValue: currentConsent
      }
    },
    "local"
  );
  listeners.storageChanged(
    { unrelated: { newValue: true } },
    "local"
  );
  listeners.storageChanged(
    {
      bggHardBlockerConsent: {
        oldValue: undefined,
        newValue: currentConsent
      }
    },
    "sync"
  );
  await settle();
  assert.equal(queries.length, 1, "non-transition storage changes refreshed tabs");

  console.log("background: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
