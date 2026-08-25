import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { resolveCodexCliPath } from "../../../shared/node/inference-router-local.js";

export type CodexCliUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

type CodexCliEvent = {
  readonly text?: string;
  readonly usage?: CodexCliUsage;
  readonly error?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeToken(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

export function parseCodexCliEvent(line: string): CodexCliEvent {
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return {}; }
  const event = record(parsed);
  if (event == null) return {};
  const item = record(event.item);
  if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") return { text: item.text };
  if (event.type === "turn.completed") {
    const usage = record(event.usage);
    return { usage: { inputTokens: safeToken(usage?.input_tokens), outputTokens: safeToken(usage?.output_tokens), cacheReadTokens: safeToken(usage?.cached_input_tokens), cacheWriteTokens: 0 } };
  }
  if (event.type === "turn.failed" || event.type === "error") {
    const detail = record(event.error);
    const message = typeof detail?.message === "string" ? detail.message : typeof event.message === "string" ? event.message : line;
    return { error: message };
  }
  return {};
}

export function codexCliArguments(args: {
  readonly cwd: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly mcpServerUrl?: string;
}): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--color", "never",
    "--cd", args.cwd,
    "--model", args.model,
    ...(args.reasoningEffort == null ? [] : ["--config", `model_reasoning_effort=${JSON.stringify(args.reasoningEffort)}`]),
    ...(args.mcpServerUrl == null ? [] : [
      "--config", `mcp_servers.onebot_plugins.url=${JSON.stringify(args.mcpServerUrl)}`,
      "--config", "mcp_servers.onebot_plugins.required=true",
    ]),
    "-",
  ];
}

export async function runCodexCliTurn(args: {
  readonly prompt: string;
  readonly cwd: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly mcpServerUrl?: string;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
  readonly onUsage?: (usage: CodexCliUsage) => void;
}): Promise<string> {
  const executable = resolveCodexCliPath();
  if (executable == null) throw new Error("Codex CLI is not installed. Install it and run codex login first.");
  await mkdir(args.cwd, { recursive: true });
  const child = spawn(executable, codexCliArguments(args), {
    cwd: args.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(args.prompt);
  let stdout = "", stderr = "", finalText = "", failure = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-16_384); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += String(chunk);
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line.length === 0) continue;
      const event = parseCodexCliEvent(line);
      if (event.text != null) {
        const delta = event.text.startsWith(finalText) ? event.text.slice(finalText.length) : event.text;
        finalText = event.text;
        if (delta.length > 0) args.onTextDelta?.(delta, finalText);
      }
      if (event.usage != null) args.onUsage?.(event.usage);
      if (event.error != null) failure = event.error;
    }
  });
  const exit = await exitPromise;
  if (exit.code !== 0) throw new Error(failure || stderr.trim() || `Codex CLI exited with ${exit.signal ?? exit.code}.`);
  if (finalText.length === 0) throw new Error(failure || "Codex CLI ended without a final agent message.");
  return finalText;
}
