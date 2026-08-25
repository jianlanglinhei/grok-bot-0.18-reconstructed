import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(relative) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "onebot-computer-connector-"));
  const output = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, relative)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("egress connector preserves routed Aone computer methods", async () => {
  const loaded = await load("source/electron-main/box/remote-connector-egress.ts");
  try {
    const wrapped = loaded.module.createEgressConnectionObserver().wrap({
      connect: async () => ({ ok: true }),
      listRoutedComputerTools: async () => ["browser"],
      executeRoutedComputerTool: async request => request,
    });
    assert.deepEqual(await wrapped.listRoutedComputerTools(), ["browser"]);
    assert.deepEqual(await wrapped.executeRoutedComputerTool({ name: "browser" }), { name: "browser" });
  } finally { await loaded.dispose(); }
});

test("client-pause connector blocks routed computer execution while paused", async () => {
  const loaded = await load("source/electron-main/box/box-client-pause.ts");
  try {
    let paused = false;
    const wrapped = loaded.module.wrapRemoteHostConnectorWithClientPause({
      connect: async () => ({ ok: true }),
      listRoutedComputerTools: async () => ["browser"],
      executeRoutedComputerTool: async request => request,
    }, () => paused);
    assert.deepEqual(await wrapped.listRoutedComputerTools(), ["browser"]);
    paused = true;
    assert.deepEqual(await wrapped.listRoutedComputerTools(), []);
    await assert.rejects(() => wrapped.executeRoutedComputerTool({}), /paused/i);
  } finally { await loaded.dispose(); }
});
