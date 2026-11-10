/**
 * Offline site tests for a single-plugin catalog.
 *
 * These cover the same guarantees as the upstream test suite — README HTML
 * sanitising and link rewriting, catalog validation, market-index alignment,
 * install-command derivation, and local package assets — without the
 * multi-plugin fixtures that only made sense for a larger catalog.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";

import { derive, marketIndex, renderReadme, renderSite, validateCatalog } from "./render.mjs";

const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
const pkg = catalog.plugins[0];

const ctx = {
  repository: "https://github.com/summerscar/dsh-plugins",
  directory: "plugins/dsh-mnemon-sync",
  readmePath: "README.md",
  assetPages: { "docs/shot.png": "../../assets/packages/mnemon-sync/docs/shot.png", "docs/logo.png": "../../assets/packages/mnemon-sync/docs/logo.png" },
  readmePages: { "plugins/dsh-mnemon-sync/docs/README.zh-CN.md": "../../plugins/mnemon-sync/", "plugins/dsh-mnemon-sync/README.md": "./" },
  packagePages: { "@summerscar/dsh-mnemon-sync": "../mnemon-sync/" },
};

test("README rendering drops the title and language switch, and rewrites links", () => {
  const { html, toc } = renderReadme(
    [
      "# @summerscar/dsh-mnemon-sync",
      "",
      "[简体中文](docs/README.zh-CN.md)",
      "",
      "Needs [the plugin](https://www.npmjs.com/package/@summerscar/dsh-mnemon-sync) and [design](../../docs/design.md#limits).",
      "",
      "![shot](docs/shot.png) ![outside](../../assets/x.png)",
      "",
      "## Install",
      "## Install",
      "## Use `it`",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n"),
    ctx,
  );
  assert.doesNotMatch(html, /<h1|简体中文/);
  assert.match(html, /href="\.\.\/mnemon-sync\/"/);
  assert.match(html, /href="https:\/\/github\.com\/summerscar\/dsh-plugins\/blob\/HEAD\/docs\/design\.md#limits"/);
  assert.match(html, /src="\.\.\/\.\.\/assets\/packages\/mnemon-sync\/docs\/shot\.png"/);
  assert.match(html, /src="https:\/\/raw\.githubusercontent\.com\/summerscar\/dsh-plugins\/HEAD\/assets\/x\.png"/);
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.deepEqual(toc.map((h) => h.id), ["install", "install-1", "use-it"]);
});

test("README rendering never passes raw HTML or unsafe URLs through", () => {
  const { html } = renderReadme(
    [
      '<p align="center"><img src="docs/logo.png" alt="Logo" onerror="alert(1)"></p>',
      "",
      "<script>alert(1)</script>",
      "",
      "Inline <b onclick=x>bold</b> [bad](javascript:alert(1)) ![x](data:image/svg+xml,evil)",
      "",
      "```html",
      "<script>ok</script>",
      "```",
    ].join("\n"),
    ctx,
  );
  assert.doesNotMatch(html, /<script|onerror|onclick|javascript:|data:image/);
  assert.match(html, /<img src="\.\.\/\.\.\/assets\/packages\/mnemon-sync\/docs\/logo\.png" alt="Logo"/);
  assert.match(html, /&lt;script&gt;ok&lt;\/script&gt;/);
});

test("catalog validation rejects duplicates and missing translations", () => {
  validateCatalog(catalog);
  const broken = structuredClone(catalog);
  broken.plugins.push(structuredClone(pkg)); // duplicate slug + duplicate package
  assert.throws(() => validateCatalog(broken), /duplicate slug/);
  const missing = structuredClone(catalog);
  delete missing.plugins[0].summary.en;
  assert.throws(() => validateCatalog(missing), /missing summary\.en/);
  // A category needs both languages too: the sidebar and breadcrumb print it,
  // so a half-translated one would render a raw id in one of the two sites.
  const halfCategory = structuredClone(catalog);
  delete halfCategory.categories[0].title.zh;
  assert.throws(() => validateCatalog(halfCategory), /category .* missing zh copy/);
});

test("every category the catalog declares is translated, and none is orphaned", () => {
  // The plugin's own manifest picks a category id; the site must carry a
  // matching entry or render.mjs rejects the plugin outright.
  for (const entry of catalog.plugins) {
    const match = catalog.categories.find((c) => c.id === entry.category);
    assert.ok(match, `${entry.slug}: no category named ${entry.category}`);
    for (const lang of ["zh", "en"]) {
      assert.equal(typeof match.title[lang], "string");
      assert.ok(match.title[lang].length > 0);
    }
  }
  assert.deepEqual(catalog.categories.map((c) => c.id).sort(), ["sessions", "tool"]);
});

function fixture() {
  const data = {};
  data[pkg.package] = {
    name: pkg.package,
    version: "0.1.11",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-02-01T00:00:00.000Z",
    versions: [{ version: "0.1.11", date: "2026-02-01T00:00:00.000Z" }],
    manifest: {
      license: "SEE LICENSE IN LICENSE",
      engines: { dsh: ">=0.2.1-rc.1" },
      dependencies: {},
      peerDependencies: { "dsh-mnemon": ">=0.5.40" },
      peerDependenciesMeta: { "dsh-mnemon": { optional: true } },
      keywords: [pkg.slug],
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    },
    files: ["/LICENSE", "/README.md"],
    // Only the English README is present in this fixture: the Chinese page
    // falls back to it, which is what the asset-rewriting test below relies on.
    readme: {
      en: { path: pkg.readme.en, text: `# ${pkg.package}\n\nSee [zh](${pkg.readme.zh}).\n\n## Usage\n\nText.` },
    },
    icon: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  };
  return data;
}

test("the Git market index stays aligned with the catalog", () => {
  const market = JSON.parse(readFileSync(new URL("../index.json", import.meta.url), "utf8"));
  assert.equal(market.format, 1);
  assert.deepEqual(market.plugins.map((p) => p.name), catalog.plugins.filter((p) => p.kind !== "service").map((p) => p.package));
  for (const entry of market.plugins) {
    const plugin = catalog.plugins.find((p) => p.package === entry.name);
    assert.deepEqual(entry.title, plugin.title);
    assert.deepEqual(entry.description, plugin.summary);
    assert.equal(entry.metadata.category, plugin.category);
    assert.deepEqual(entry.repository, { url: plugin.repository, ...(plugin.directory ? { directory: plugin.directory } : {}) });
    assert.ok(entry.versions.length > 0);
    for (const version of entry.versions) {
      assert.equal(version.source.type, "npm");
      assert.ok(Number.isInteger(version.publishTimestamp) && version.publishTimestamp >= 0);
    }
  }
});

test("site rendering covers the plugin in both languages with valid local links", () => {
  const data = fixture();
  const files = renderSite(catalog, data, { generatedAt: "2026-03-01T00:00:00.000Z" });
  for (const p of catalog.plugins) {
    assert.ok(files.has(`plugins/${p.slug}/index.html`), p.slug);
    assert.ok(files.has(`en/plugins/${p.slug}/index.html`), p.slug);
    assert.ok(files.has(`assets/icons/${p.slug}.svg`), p.slug);
  }
  // The plugin itself is always installed by name; its optional peer is not.
  const page = files.get(`plugins/${pkg.slug}/index.html`);
  assert.match(page, /dsh plugin --profile web add @summerscar\/dsh-mnemon-sync/);
  assert.doesNotMatch(page, /add dsh-mnemon/);

  const siteIndex = JSON.parse(files.get("index.json"));
  assert.equal(siteIndex.format, 1);
  assert.deepEqual(siteIndex.plugins.map((p) => p.name), [pkg.package]);
  const entry = siteIndex.plugins[0];
  assert.equal(entry.metadata.category, pkg.category);
  assert.equal(entry.versions[0].publishTimestamp, Math.floor(Date.parse(data[pkg.package].modified) / 1000));
  assert.equal(entry.versions[0].engines.dsh, ">=0.2.1-rc.1");
  assert.equal(entry.repository.directory, "plugins/dsh-mnemon-sync");
  assert.deepEqual(Object.keys(siteIndex.metadata.categories).sort(), [...new Set(siteIndex.plugins.map((p) => p.metadata.category))].sort());

  // Versions without a parseable date are ignored; a later version does not
  // displace the published one as "current".
  data[pkg.package].versions.push({ version: "0.0.1", date: "not-a-date" });
  assert.deepEqual(
    JSON.parse(marketIndex({ catalog, plugins: derive(catalog, data) }))
      .plugins[0].versions.map((v) => v.version),
    ["0.1.11"],
  );

  const json = JSON.parse(files.get("plugins.json"));
  assert.equal(json.plugins.length, catalog.plugins.length);
  assert.deepEqual(json.plugins[0].dependsOn, []);
  assert.deepEqual(json.plugins[0].install, ["dsh plugin --profile web add @summerscar/dsh-mnemon-sync"]);
  assert.match(files.get("404.html"), /areas/);
  assert.match(files.get("llms.txt"), /index\.json/);

  // Changelog pages exist in both languages and list the fixture version.
  for (const langPrefix of ["", "en/"]) {
    const changelog = files.get(`${langPrefix}changelog/index.html`);
    assert.ok(changelog, `${langPrefix}changelog`);
    assert.match(changelog, /0\.1\.11/);
  }

  // Every relative href/src in generated HTML resolves to a generated asset.
  const known = new Set([...files.keys(), "assets/site.css", "assets/site.js"]);
  const missing = [];
  for (const [path, content] of files) {
    if (!path.endsWith(".html") || path === "404.html") continue;
    for (const [, url] of content.matchAll(/(?:href|src)="([^"#?]*)[^"]*"/g)) {
      if (!url || /^[a-z]+:/i.test(url)) continue;
      let target = posix.normalize(posix.join(posix.dirname(path), url));
      if (url.endsWith("/") || target === ".") target = posix.join(target, "index.html");
      if (!known.has(target)) missing.push(`${path} -> ${url}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("both languages serve package images and licenses from relative local assets", () => {
  const data = fixture();
  const item = catalog.plugins[0];
  const pkgData = data[item.package];
  pkgData.assets = { "docs/a b.png": Buffer.from([0, 255, 127]).toString("base64"), LICENSE: Buffer.from("Published license").toString("base64") };
  pkgData.readme.en = { path: "README.md", text: "# Sync\n\n## Usage\n\n![Example](docs/a%20b.png)\n\n[License](LICENSE#terms)" };
  const options = { generatedAt: "2026-10-01T00:00:00.000Z" };
  const files = renderSite(catalog, data, options);
  for (const [lang, root] of [["", "../../"], ["en/", "../../../"]]) {
    const html = files.get(`${lang}plugins/${item.slug}/index.html`);
    assert.ok(html.includes(`src="${root}assets/packages/${item.slug}/docs/a%20b.png"`));
    assert.ok(html.includes(`href="${root}assets/packages/${item.slug}/LICENSE#terms"`));
    assert.ok(html.includes(`href="${root}assets/packages/${item.slug}/LICENSE"`));
    assert.doesNotMatch(html, /jsdelivr/);
  }
  assert.deepEqual(files.get(`assets/packages/${item.slug}/docs/a b.png`), Buffer.from([0, 255, 127]));
  assert.equal(files.get(`assets/packages/${item.slug}/LICENSE`).toString(), "Published license");
  pkgData.assets["../escape.png"] = "AA==";
  assert.throws(() => renderSite(catalog, data, options), /Unsafe package asset path/);
});
