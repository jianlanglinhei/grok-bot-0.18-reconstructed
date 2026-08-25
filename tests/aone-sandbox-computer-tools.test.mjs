import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/aone-sandbox-computer-tools.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("Aone routed computer tools expose visible browser open and screenshot", async () => {
  const module = await loadModule();
  const tools = module.listAoneRoutedComputerTools();
  assert.deepEqual(tools.map(tool => tool.name), ["onebot_browser_open", "onebot_computer_screenshot"]);
  assert.ok(tools.every(tool => tool.providerIdentifier === "onebot-computer"));
});

test("Aone browser target accepts HTTP URLs and turns names into a visible search", async () => {
  const module = await loadModule();
  assert.equal(module.resolveAoneBrowserTarget("https://example.com/path"), "https://example.com/path");
  assert.equal(module.resolveAoneBrowserTarget("example.com/path"), "https://example.com/path");
  assert.equal(module.resolveAoneBrowserTarget("mirrna"), "https://www.baidu.com/s?wd=mirrna");
  assert.throws(() => module.resolveAoneBrowserTarget("file:///etc/passwd"), /Only HTTP/);
});

test("Aone visible browser command quotes the resolved URL", async () => {
  const module = await loadModule();
  const command = module.buildAoneBrowserOpenCommand("https://example.com/?q=a'b");
  assert.match(command, /xdotool windowactivate/);
  assert.match(command, /xdotool key --clearmodifiers ctrl\+l/);
  assert.doesNotMatch(command, /xdotool key --window/);
  assert.match(command, /'"'"'/);
});

test("Aone reconnect keeps persisted sandboxes on transient DNS and network errors", async () => {
  const module = await loadModule();
  assert.equal(module.isTransientAoneConnectionError(Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) })), true);
  assert.equal(module.isTransientAoneConnectionError(new Error("sandbox was not found")), false);
});
