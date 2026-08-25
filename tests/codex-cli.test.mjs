import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "onebot-codex-cli-"));
  const output = path.join(temporary, "codex-cli.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/codex-cli.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, temporary, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("Codex CLI JSONL events expose the final message and usage", async () => {
  const loaded = await loadModule();
  try {
    assert.deepEqual(loaded.module.parseCodexCliEvent('{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}'), { text: "hello" });
    assert.deepEqual(loaded.module.parseCodexCliEvent('{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":7,"output_tokens":3}}'), {
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 0 },
    });
  } finally { await loaded.dispose(); }
});

test("local Codex CLI runner uses an ephemeral read-only run with the onebot MCP bridge", async () => {
  const loaded = await loadModule();
  const executable = path.join(loaded.temporary, "fake-codex");
  const argsFile = path.join(loaded.temporary, "args.txt");
  const oldCodexPath = process.env.CODEX_PATH;
  try {
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "$ONEBOT_TEST_ARGS"\ncat >/dev/null\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"LOCAL_CLI_OK"}}'\nprintf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":2,"output_tokens":1}}'\n`);
    await chmod(executable, 0o755);
    process.env.CODEX_PATH = executable;
    process.env.ONEBOT_TEST_ARGS = argsFile;
    let streamed = "";
    let usage;
    const result = await loaded.module.runCodexCliTurn({
      prompt: "hello",
      cwd: path.join(loaded.temporary, "workspace"),
      model: "gpt-test",
      reasoningEffort: "high",
      mcpServerUrl: "http://127.0.0.1:4321/mcp/test",
      onTextDelta: (_delta, accumulated) => { streamed = accumulated; },
      onUsage: value => { usage = value; },
    });
    assert.equal(result, "LOCAL_CLI_OK");
    assert.equal(streamed, "LOCAL_CLI_OK");
    assert.deepEqual(usage, { inputTokens: 5, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0 });
    const argv = (await readFile(argsFile, "utf8")).trim().split("\n");
    assert.ok(argv.includes("--json"));
    assert.ok(argv.includes("--ephemeral"));
    assert.ok(argv.includes("read-only"));
    assert.ok(argv.some(value => value.includes("mcp_servers.onebot_plugins.url=")));
  } finally {
    if (oldCodexPath === undefined) delete process.env.CODEX_PATH; else process.env.CODEX_PATH = oldCodexPath;
    delete process.env.ONEBOT_TEST_ARGS;
    await loaded.dispose();
  }
});
