// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "page-bridge.js"),
  "utf8"
);

async function bridgeResult(pathname) {
  const context = vm.createContext({
    URL,
    location: { href: `https://boardgamegeek.com${pathname}` },
    localStorage: { removeItem() {} },
    window: { fetch: null },
    XMLHttpRequest: undefined
  });
  vm.runInContext(source, context);
  return context.installBggBlockListBridge({ channelNonce: "a".repeat(32) });
}

(async () => {
  assert.equal(
    (await bridgeResult("/subscriptions")).reason,
    "bridge-unavailable",
    "the private authorization bridge rejected /subscriptions before capability checks"
  );
  assert.equal(
    (await bridgeResult("/subscriptions/")).reason,
    "bridge-unavailable",
    "the private authorization bridge rejected /subscriptions/ before capability checks"
  );
  assert.equal(
    (await bridgeResult("/subscriptions/blocks?feedType=user")).reason,
    "unsupported-page",
    "the private bridge expanded beyond the exact subscriptions feed"
  );
  console.log("page bridge scope: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
