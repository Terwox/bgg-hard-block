// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const chromeManifest = require(path.join(__dirname, "..", "manifest.json"));
const firefoxManifest = require(path.join(__dirname, "..", "manifest.firefox.json"));

// The Firefox manifest is a checked-in sibling rather than a generated file, so
// the only thing standing between it and silent divergence is this test.
const ALLOWED_DELTAS = [
  "minimum_chrome_version",
  "background",
  "browser_specific_settings"
];

function withoutAllowedDeltas(manifest) {
  const copy = structuredClone(manifest);
  for (const key of ALLOWED_DELTAS) {
    delete copy[key];
  }
  return copy;
}

assert.deepStrictEqual(
  withoutAllowedDeltas(firefoxManifest),
  withoutAllowedDeltas(chromeManifest),
  `the two manifests may differ only in ${ALLOWED_DELTAS.join(", ")}`
);

assert.equal(
  Object.hasOwn(firefoxManifest, "minimum_chrome_version"),
  false,
  "minimum_chrome_version is a Chrome-only key and must not ship to AMO"
);

assert.equal(
  Object.hasOwn(firefoxManifest.background, "service_worker"),
  false,
  "Firefox has no background.service_worker; declaring it is a dead key the linter flags"
);

assert.deepStrictEqual(
  firefoxManifest.background.scripts,
  ["src/page-bridge.js", "src/background.js"],
  "load order is load-bearing: src/background.js only calls importScripts inside a " +
    "worker, so page-bridge.js must run first to define installBggBlockListBridge"
);

assert.equal(
  firefoxManifest.browser_specific_settings.gecko.id,
  "bgg-hard-block@terwox.github.io",
  "the gecko id is immutable after the first AMO upload"
);

assert.equal(
  firefoxManifest.browser_specific_settings.gecko.strict_min_version,
  "153.0",
  "documentId on senders, request details, and injection results needs Firefox 153+"
);

assert.deepStrictEqual(
  firefoxManifest.browser_specific_settings.gecko.data_collection_permissions,
  { required: ["none"] },
  "AMO requires data_collection_permissions; nothing leaves the browser except to BGG"
);

assert.equal(
  Object.hasOwn(firefoxManifest.browser_specific_settings.gecko, "gecko_android"),
  false,
  "Android is not an opted-in listing target"
);
assert.equal(
  Object.hasOwn(firefoxManifest.browser_specific_settings, "gecko_android"),
  false,
  "Android is not an opted-in listing target"
);

assert.equal(
  firefoxManifest.version,
  chromeManifest.version,
  "both stores must be offered the same version string"
);

console.log("manifest firefox scope: PASS");
