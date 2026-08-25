import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-transcript-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("routed transcript preserves structured MCP mention rich text across reload", async () => {
  const loaded = await loadModule();
  try {
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "mcp:3213107", label: "Gmail" } },
        { type: "text", text: " what's new?" },
      ] }],
    });
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "user",
          content: "@Gmail what's new?",
          richText,
          id: "t1u",
          clientNonce: "nonce-1",
          timestampMs: 123,
        }],
      },
    });
    const projected = loaded.module.projectInferenceRouterTranscriptEntry(store.agents.agent[0]);
    assert.equal(projected.richText, richText);
    assert.deepEqual(JSON.parse(projected.richText).content[0].content[0], {
      type: "mention",
      attrs: { id: "mcp:3213107", label: "Gmail" },
    });
  } finally {
    await loaded.dispose();
  }
});

test("routed transcript rejects malformed rich text carriers", async () => {
  const loaded = await loadModule();
  try {
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "user", content: "@Gmail", richText: {}, id: "t1u", timestampMs: 123 }],
      },
    });
    assert.deepEqual(store.agents.agent, []);
  } finally {
    await loaded.dispose();
  }
});

test("Aone Sandbox turns only use the local coordinator when local Codex CLI is enabled", async () => {
  const loaded = await loadModule();
  try {
    assert.equal(loaded.module.shouldRouteInferenceInCoordinator("codex", "aone-sandbox"), false);
    assert.equal(loaded.module.shouldRouteInferenceInCoordinator("codex", "aone-sandbox", true), true);
    assert.equal(loaded.module.shouldRouteInferenceInCoordinator("codex", "local-docker"), true);
    assert.equal(loaded.module.shouldRouteInferenceInCoordinator("cursor", "aone-sandbox"), false);
  } finally {
    await loaded.dispose();
  }
});

test("routed Aone computer tools publish the agent desktop after execution", async () => {
  const loaded = await loadModule();
  try {
    const calls = [];
    const dispatchRemote = async (method, args) => {
      calls.push({ method, args });
      return method === "executeRoutedMcpTool" ? { ok: true } : { state: "running" };
    };
    const result = await loaded.module.executeRoutedMcpToolForAgent(dispatchRemote, "agent-1", {
      providerIdentifier: "onebot-computer",
      name: "onebot_browser_open",
      args: { target: "mirrna" },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [
      {
        method: "executeRoutedMcpTool",
        args: {
          providerIdentifier: "onebot-computer",
          name: "onebot_browser_open",
          args: { target: "mirrna" },
          agentId: "agent-1",
        },
      },
      { method: "ensureForeverBox", args: { id: "agent-1" } },
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("non-computer routed tools do not publish the desktop", async () => {
  const loaded = await loadModule();
  try {
    const calls = [];
    await loaded.module.executeRoutedMcpToolForAgent(async (method, args) => {
      calls.push({ method, args });
      return { ok: true };
    }, "agent-1", { providerIdentifier: "plugin", name: "lookup", args: {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "executeRoutedMcpTool");
  } finally {
    await loaded.dispose();
  }
});
