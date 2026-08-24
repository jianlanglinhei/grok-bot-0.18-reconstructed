import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadConverters() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-converters-"));
  const output = path.join(temporary, "converters.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/packages/chat-inference-proto/converters.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("custom-format tools may omit JSON parameters", async () => {
  const loaded = await loadConverters();
  try {
    const request = loaded.module.buildStreamRequest({
      messages: [],
      requestedModel: { modelId: "test", maxMode: false, parameters: [] },
      tools: [{
        name: "shell",
        description: "Run a command",
        parameters: undefined,
        customToolFormat: { type: "grammar", definition: "command", syntax: "command" },
      }],
    });
    assert.equal(request.tools.length, 1);
    assert.equal(request.tools[0].parameters, undefined);
    assert.equal(request.tools[0].customToolFormat?.type, "grammar");
  } finally {
    await loaded.dispose();
  }
});

test("JSON parameter schemas still become protobuf Struct values", async () => {
  const loaded = await loadConverters();
  try {
    const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
    const request = loaded.module.buildStreamRequest({
      messages: [],
      requestedModel: { modelId: "test", maxMode: false, parameters: [] },
      tools: [{ name: "search", description: "Search", parameters: schema }],
    });
    assert.deepEqual(request.tools[0].parameters.toJson(), schema);
  } finally {
    await loaded.dispose();
  }
});
