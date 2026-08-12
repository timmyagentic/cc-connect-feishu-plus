import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transformLocalReferences } from "../references.js";
import type { ReferenceDisplayConfig } from "../types.js";

const config: ReferenceDisplayConfig = {
  normalizeAgents: ["codex"],
  renderPlatforms: ["feishu"],
  displayPath: "smart",
  markerStyle: "emoji",
  enclosureStyle: "code",
};

function transform(markdown: string, workspace = "/root/code/demo"): string {
  return transformLocalReferences(markdown, config, "codex", "feishu", workspace);
}

test("smart references hide absolute paths while preserving line locations", () => {
  assert.equal(
    transform("See /root/code/demo/src/app.ts:42"),
    "See 📄 `app.ts:42`",
  );
});

test("smart references retain one parent segment when basenames collide", () => {
  assert.equal(
    transform("Compare /root/a/config.ts and /root/b/config.ts", "/root"),
    "Compare 📄 `a/config.ts` and 📄 `b/config.ts`",
  );
});

test("reference rendering preserves web links, code fences, and version strings", () => {
  const input = [
    "[site](https://example.com/a/b) https://example.com/c/d `https://example.com/e/f` v0.2.0",
    "```ts",
    "const path = '/root/private/source.ts:9';",
    "```",
    "Inspect `/root/private/source.ts:9`.",
  ].join("\n");
  const output = transform(input);
  assert.match(output, /\[site\]\(https:\/\/example\.com\/a\/b\)/);
  assert.match(output, /https:\/\/example\.com\/c\/d/);
  assert.match(output, /`https:\/\/example\.com\/e\/f`/);
  assert.match(output, /v0\.2\.0/);
  assert.match(output, /const path = '\/root\/private\/source\.ts:9';/);
  assert.match(output, /Inspect 📄 `source\.ts:9`\./);
});

test("existing directories receive a compact directory marker", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "ccfp-reference-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const directory = join(workspace, "nested", "assets");
  await mkdir(directory, { recursive: true });
  assert.equal(transform(`Open ${directory}`, workspace), "Open 📁 `assets/`");
});

test("reference transformation remains disabled outside configured scopes", () => {
  const input = "See /root/code/demo/src/app.ts:42";
  assert.equal(
    transformLocalReferences(input, config, "codex", "lark", "/root/code/demo"),
    transform(input),
  );
  assert.equal(
    transformLocalReferences(
      input,
      { ...config, normalizeAgents: [] },
      "codex",
      "feishu",
      "/root/code/demo",
    ),
    input,
  );
});
