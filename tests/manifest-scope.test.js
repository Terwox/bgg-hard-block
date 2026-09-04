// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Terwox
//
// This file is part of BGG Hard Block. See the LICENSE file at the repository
// root for the full license text.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const manifest = require(path.join(__dirname, "..", "manifest.json"));

const discussionMatches = [
  "https://boardgamegeek.com/forum/*",
  "https://boardgamegeek.com/thread/*",
  "https://boardgamegeek.com/geeklist/*",
  "https://boardgamegeek.com/image/*",
  "https://boardgamegeek.com/video/*",
  "https://boardgamegeek.com/filepage/*",
  "https://boardgamegeek.com/blog/*/blogpost/*",
  "https://boardgamegeek.com/subscriptions",
  "https://boardgamegeek.com/subscriptions/"
];

assert.deepEqual(
  manifest.host_permissions,
  ["https://boardgamegeek.com/*", "https://api.geekdo.com/*"],
  "host access must stay on BGG's canonical page and API HTTPS origins"
);

assert.deepEqual(
  manifest.permissions,
  ["scripting", "storage", "webRequest"],
  "BGG-only credential capture may observe requests but must not request tabs or navigation history"
);

assert.equal(
  manifest.content_scripts.length,
  1,
  "only the consent-gated isolated filter may be declaratively installed"
);
assert.deepEqual(
  manifest.content_scripts[0].js,
  ["src/content-core.js", "src/content.js"],
  "MAIN-world and settings bridges must remain background-authorized"
);
assert.equal(manifest.content_scripts[0].world, "ISOLATED");
assert.equal(manifest.content_scripts[0].run_at, "document_start");

for (const contentScript of manifest.content_scripts) {
  assert.deepEqual(
    contentScript.matches,
    discussionMatches,
    "every content-script world must use the same discussion-only scope"
  );
}

const unrelatedPages = [
  "https://boardgamegeek.com/",
  "https://boardgamegeek.com/boardgame/174430/gloomhaven",
  "https://boardgamegeek.com/collection/user/Terwox",
  "https://boardgamegeek.com/subscriptions/blocks?feedType=user",
  "https://boardgamegeek.com/forums",
  "https://boardgamegeek.com/threads/region/1",
  "https://www.boardgamegeek.com/thread/3708408/article/48017278",
  "http://boardgamegeek.com/thread/3708408/article/48017278"
];

function patternMatches(pattern, urlText) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(urlText);
}

for (const url of unrelatedPages) {
  assert.equal(
    discussionMatches.some((pattern) => patternMatches(pattern, url)),
    false,
    `unrelated URL remained in content-script scope: ${url}`
  );
}

for (const url of [
  "https://boardgamegeek.com/forum/3325850/rsp-guild/general",
  "https://boardgamegeek.com/thread/3708408/article/48017278",
  "https://boardgamegeek.com/geeklist/379404/example",
  "https://boardgamegeek.com/image/701383/example",
  "https://boardgamegeek.com/video/492443/example/example",
    "https://boardgamegeek.com/filepage/314312/example",
    "https://boardgamegeek.com/blog/1/blogpost/188142/example",
    "https://boardgamegeek.com/subscriptions",
    "https://boardgamegeek.com/subscriptions/"
]) {
  assert.equal(
    discussionMatches.some((pattern) => patternMatches(pattern, url)),
    true,
    `discussion URL fell out of content-script scope: ${url}`
  );
}

console.log("manifest scope: PASS");
