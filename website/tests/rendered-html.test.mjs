import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";

const siteRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html", host: "fovea.example" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Fovea showcase page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Fovea — See it\. Ask it\.<\/title>/);
  assert.match(html, /<html[^>]*\blang="en"/);
  assert.match(html, /<html[^>]*\bdata-theme="dark"/);
  assert.match(html, /aria-label="Fovea home"/);
  assert.match(html, /aria-label="Primary navigation"/);
  assert.match(html, /<section[^>]*\bclass="hero"[^>]*\bid="top"/);
  assert.match(html, /id="how-it-works"/);
  assert.match(html, /id="features"/);
  assert.match(html, /aria-label="Fovea feature demonstrations"/);
  assert.match(html, /property="og:image"[^>]*content="https:\/\/fovea\.example\/og\.png"/);

  // The vinext starter skeleton must not leak back into the rendered page.
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /Your site is taking shape/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("the starter preview scaffolding has been removed", async () => {
  const [page, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", siteRoot), "utf8"),
    readFile(new URL("package.json", siteRoot), "utf8"),
  ]);

  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  const previewDirectory = new URL("app/_sites-preview/", siteRoot);
  let previewEntries = [];
  try {
    previewEntries = await readdir(previewDirectory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.deepEqual(previewEntries, [], "app/_sites-preview must be empty or absent");
  await assert.rejects(access(new URL("public/_sites-preview", siteRoot)));
});
