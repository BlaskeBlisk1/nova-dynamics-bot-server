const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, publicDemoConfig, safeSlug } = require("../index");

const demoFiles = [
  "public/demo/index.html",
  "public/demo/styles.css",
  "public/demo/app.js"
];

for (const file of demoFiles) {
  assert.equal(fs.existsSync(path.join(process.cwd(), file)), true, `${file} is missing.`);
}

const routePaths = app._router.stack
  .filter((layer) => layer.route)
  .flatMap((layer) => Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]);

assert.ok(routePaths.includes("/demos/:client"));
assert.ok(routePaths.includes("/demos/:client/"));
assert.ok(routePaths.includes("/api/demo-config/:client"));

for (const client of ["bedriver", "fyllingsdalen", "fram"]) {
  const config = publicDemoConfig(client);
  assert.equal(config.client, client);
  assert.ok(config.name.length > 3);
  assert.ok(config.suggestedQuestions.length >= 2);
  assert.match(config.website, /^https:\/\//);
}

assert.equal(safeSlug("BE Driver !!"), "bedriver");
assert.equal(safeSlug("../../secret"), "secret");

console.log("✅ Demo routes, assets and public configurations passed smoke tests.");
