import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Sandbox } from "@ali/aone-sandbox";

import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import { readSecret, writeSecret } from "../secrets/secret-store.js";
import { readA1GroundApiKey } from "./aone-sandbox-credential.js";
import { buildAoneNoVncUrl } from "./aone-sandbox-vnc.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

export const AONE_SANDBOX_API_KEY_SECRET = "aone-sandbox-api-key";
export const AONE_SANDBOX_GATEWAY_TOKEN_SECRET = "aone-sandbox-gateway-token";
export const AONE_SANDBOX_DEFAULT_DOMAIN = "sandbox.aone.alibaba-inc.com";
export const AONE_SANDBOX_IMAGE = "hub.docker.alibaba-inc.com/aone-base-global/code-interpreter:v1.0.2_accelerated";
export const AONE_SANDBOX_GATEWAY_PORT = 1340;
export const AONE_SANDBOX_VNC_PORT = 6080;
export const AONE_SANDBOX_FORK_VNC_PORT = 6081;
export const AONE_SANDBOX_CODEX_RELAY_PORT = 1341;
const AONE_SANDBOX_TTL_SECONDS = 6 * 60 * 60;
const AONE_SANDBOX_READY_TIMEOUT_MS = 180_000;
const AONE_SANDBOX_DESKTOP_READY_TIMEOUT_MS = 60_000;
const OPTIONAL_CREDENTIAL_TIMEOUT_MS = 5_000;
const AONE_PRIVATE_FILE_MODE = 600;
const AONE_NODE_DEPS_ROOT = "/opt/onebot/node-deps/node_modules";
const AONE_BOX_EXEC_DAEMON_PORT = 1337;
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const AONE_DESKTOP_PACKAGES = [
  "xorg-x11-server-Xvfb",
  "x11vnc",
  "novnc",
  "python3-websockify",
  "openbox",
  "xterm",
  "chromium",
  "xdotool",
  "ImageMagick",
  "dbus-x11",
  "dejavu-sans-fonts",
] as const;

function logAoneSandbox(message: string): void {
  console.log(`[onebot][aone-sandbox] ${message}`);
}

interface HostBundle {
  readonly path: string;
  readonly sha256: string;
  readonly supportFiles: readonly { readonly relativePath: string; readonly path: string }[];
  readonly boxExecDaemonPath: string;
  readonly boxExecDaemonSha256: string;
}

interface AoneSandboxState {
  readonly schemaVersion: 2;
  readonly sandboxId: string;
  readonly hostSha256: string;
  readonly boxExecDaemonSha256: string;
  readonly provider: string;
  readonly createdAt: string;
}

export interface AoneSandboxStatus {
  readonly configured: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly sandboxId: string | null;
  readonly detail: string;
}

function statePath(settingsPath: string): string {
  return join(dirname(settingsPath), "aone-sandbox.json");
}

function isState(value: unknown): value is AoneSandboxState {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 2
    && typeof record.sandboxId === "string" && record.sandboxId.length > 0
    && typeof record.hostSha256 === "string" && record.hostSha256.length > 0
    && typeof record.boxExecDaemonSha256 === "string" && record.boxExecDaemonSha256.length > 0
    && typeof record.provider === "string" && record.provider.length > 0
    && typeof record.createdAt === "string";
}

async function readState(settingsPath: string): Promise<AoneSandboxState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(settingsPath), "utf8"));
    return isState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeState(settingsPath: string, state: AoneSandboxState): Promise<void> {
  const target = statePath(settingsPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  logAoneSandbox(`state persisted at ${target}`);
}

async function apiKey(): Promise<string> {
  const value = process.env.AONE_SANDBOX_API_KEY?.trim()
    || process.env.OPEN_SANDBOX_API_KEY?.trim()
    || (await readA1GroundApiKey())?.trim()
    || (await readSecret(AONE_SANDBOX_API_KEY_SECRET))?.trim();
  if (value == null || value.length === 0) throw new Error("Aone Sandbox needs an API key. Log in with a1 ground or save a key in Settings → Router first.");
  return value;
}

async function gatewayToken(): Promise<string> {
  const stored = (await readSecret(AONE_SANDBOX_GATEWAY_TOKEN_SECRET))?.trim();
  if (stored != null && stored.length >= 32) return stored;
  const created = randomBytes(32).toString("hex");
  await writeSecret(AONE_SANDBOX_GATEWAY_TOKEN_SECRET, created);
  return created;
}

function connectionConfig(key: string) {
  return {
    apiKey: key,
    domain: process.env.AONE_SANDBOX_DOMAIN?.trim() || AONE_SANDBOX_DEFAULT_DOMAIN,
    protocol: "https" as const,
    requestTimeoutSeconds: 60,
  };
}

async function privateCodexAuth(): Promise<Uint8Array> {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
    throw new Error("Codex login credentials must be a private direct regular file before they can be copied to Aone Sandbox.");
  }
  return await readFile(path);
}

function endpointUrl(value: string, suffix = ""): string {
  const base = value.endsWith("/") ? value : `${value}/`;
  return suffix.length === 0 ? base.slice(0, -1) : new URL(suffix.replace(/^\//u, ""), base).toString();
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function gatewayReady(baseUrl: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(endpointUrl(baseUrl, "health"), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function gatewayConnection(sandbox: Sandbox, token: string): Promise<GatewayConnection> {
  const [baseUrl, primaryVncBaseUrl, forkVncBaseUrl] = await Promise.all([
    sandbox.getEndpointUrl(AONE_SANDBOX_GATEWAY_PORT),
    sandbox.getEndpointUrl(AONE_SANDBOX_VNC_PORT),
    sandbox.getEndpointUrl(AONE_SANDBOX_FORK_VNC_PORT),
  ]);
  return {
    baseUrl: endpointUrl(baseUrl),
    token,
    vncProxy: {
      primaryUrl: buildAoneNoVncUrl(primaryVncBaseUrl, token),
      forkBaseUrl: endpointUrl(forkVncBaseUrl),
      networkToken: token,
    },
  };
}

async function waitForGateway(connection: GatewayConnection): Promise<void> {
  const deadline = Date.now() + AONE_SANDBOX_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(connection.baseUrl, connection.token ?? "")) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Aone Sandbox started, but its onebot gateway did not become ready within three minutes.");
}

async function resolveNodePath(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.commands.run("node_path=$(command -v node 2>/dev/null || true); if [ -z \"$node_path\" ]; then node_path=$(find /opt/taobao/install/nvm/versions/node -type f -path '*/bin/node' -perm -111 2>/dev/null | sort -V | tail -n 1); fi; printf '%s\\n' \"$node_path\"");
  const nodePath = result.logs.stdout.map((message) => message.text).join("").trim().split(/\s+/u).at(-1);
  if (nodePath == null || !nodePath.startsWith("/")) {
    const stderr = result.logs.stderr.map((message) => message.text).join("").trim();
    throw new Error(`Aone Sandbox does not expose an absolute Node.js executable path${stderr.length === 0 ? "." : `: ${stderr}`}`);
  }
  return nodePath;
}

function desktopStartScript(nodePath: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

mkdir -p /opt/onebot/logs /opt/onebot/run /opt/onebot/data/chromium /opt/onebot/terminals /workspace

start_onebot_process() {
  local name="$1"
  shift
  local pid_file="/opt/onebot/run/\${name}.pid"
  if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    return 0
  fi
  nohup "$@" >"/opt/onebot/logs/\${name}.log" 2>&1 </dev/null &
  echo $! >"$pid_file"
}

start_onebot_process xvfb Xvfb :0 -screen 0 1440x900x24 -ac -nolisten tcp
for _ in $(seq 1 50); do
  [ -S /tmp/.X11-unix/X0 ] && break
  sleep 0.1
done
[ -S /tmp/.X11-unix/X0 ]

export DISPLAY=:0
start_onebot_process openbox openbox-session
start_onebot_process x11vnc x11vnc -display :0 -forever -shared -rfbport 5900 -nopw -listen 127.0.0.1 -noxdamage
start_onebot_process websockify websockify --web /usr/share/novnc --token-plugin TokenFile --token-source /opt/onebot/vnc.tokens 0.0.0.0:${AONE_SANDBOX_VNC_PORT}
start_onebot_process chromium chromium-browser --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --disable-default-apps --user-data-dir=/opt/onebot/data/chromium --window-size=1380,820 about:blank
start_onebot_process box-exec env DISPLAY=:0 SAND_BOX_WORKSPACE_ROOT=/workspace SAND_BOX_TERMINALS_DIRECTORY=/opt/onebot/terminals SAND_BOX_EXEC_DAEMON_PORT=${AONE_BOX_EXEC_DAEMON_PORT} SAND_BOX_EXEC_DAEMON_AUTH_TOKEN=local ${shellValue(nodePath)} /opt/onebot/box-exec-daemon/main.cjs
`;
}

function codexRelayServerSource(): string {
  return String.raw`const http = require("node:http");
const { randomUUID } = require("node:crypto");
const token = process.env.SAND_CODEX_RELAY_TOKEN || "";
const pending = [];
const waitingPolls = [];
const completions = new Map();
function authorized(req) { return req.headers.authorization === "Bearer " + token; }
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); req.on("error", reject); }); }
function flushPoll() { while (pending.length > 0 && waitingPolls.length > 0) { const res = waitingPolls.shift(); clearTimeout(res.pollTimer); const task = pending.shift(); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(task)); } }
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (req.url === "/proxy" && req.method === "POST") {
    if (req.headers["x-onebot-relay-token"] !== token) { res.writeHead(401); res.end(); return; }
    const id = randomUUID();
    const body = await readBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).flatMap(([name, value]) => typeof value === "string" ? [[name, value]] : []));
    const completion = new Promise((resolve, reject) => { const timer = setTimeout(() => { completions.delete(id); reject(new Error("local Codex relay timed out")); }, 120000); completions.set(id, value => { clearTimeout(timer); resolve(value); }); });
    pending.push({ id, body, headers }); flushPoll();
    try { const result = await completion; res.writeHead(result.status, result.headers); res.end(result.body); }
    catch (error) { res.writeHead(504, { "content-type": "text/plain" }); res.end(error.message); }
    return;
  }
  if (req.url === "/poll" && req.method === "GET") {
    if (!authorized(req)) { res.writeHead(401); res.end(); return; }
    waitingPolls.push(res); res.pollTimer = setTimeout(() => { const index = waitingPolls.indexOf(res); if (index >= 0) waitingPolls.splice(index, 1); res.writeHead(204); res.end(); }, 15000); flushPoll(); return;
  }
  if (req.url === "/complete" && req.method === "POST") {
    if (!authorized(req)) { res.writeHead(401); res.end(); return; }
    try { const result = JSON.parse(await readBody(req)); const complete = completions.get(result.id); if (!complete) { res.writeHead(404); res.end(); return; } completions.delete(result.id); complete(result); res.writeHead(204); res.end(); }
    catch { res.writeHead(400); res.end(); }
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(Number(process.env.SAND_CODEX_RELAY_PORT || 1341), "0.0.0.0");
`;
}

let codexRelayAbort: AbortController | undefined;
let codexRelayIdentity = "";

function startLocalCodexRelay(relayBaseUrl: string, token: string): void {
  const identity = `${relayBaseUrl}|${token}`;
  if (codexRelayIdentity === identity && codexRelayAbort?.signal.aborted === false) return;
  codexRelayAbort?.abort();
  codexRelayIdentity = identity;
  const controller = new AbortController();
  codexRelayAbort = controller;
  const allowedRequestHeaders = new Set(["accept", "authorization", "chatgpt-account-id", "content-type", "user-agent"]);
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const poll = await fetch(endpointUrl(relayBaseUrl, "poll"), {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (poll.status === 204) continue;
        if (!poll.ok) throw new Error(`Aone Codex relay poll failed (${poll.status}).`);
        const task = await poll.json() as { id: string; body: string; headers: Record<string, string> };
        const headers = new Headers();
        for (const [name, value] of Object.entries(task.headers)) if (allowedRequestHeaders.has(name.toLowerCase())) headers.set(name, value);
        const upstream = await fetch(CODEX_RESPONSES_ENDPOINT, { method: "POST", headers, body: task.body, signal: AbortSignal.timeout(120_000) });
        const completion = {
          id: task.id,
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" },
          body: await upstream.text(),
        };
        const delivered = await fetch(endpointUrl(relayBaseUrl, "complete"), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(completion),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (!delivered.ok && delivered.status !== 404) throw new Error(`Aone Codex relay completion failed (${delivered.status}).`);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("[onebot][aone-sandbox] local Codex relay retrying", error);
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    }
  })();
}

async function ensureLocalCodexRelay(sandbox: Sandbox, token: string, provider: string): Promise<void> {
  if (provider !== "codex") {
    codexRelayAbort?.abort();
    codexRelayAbort = undefined;
    codexRelayIdentity = "";
    return;
  }
  startLocalCodexRelay(await sandbox.getEndpointUrl(AONE_SANDBOX_CODEX_RELAY_PORT), token);
}

async function desktopReady(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.commands.run(`curl --max-time 2 -fsS http://127.0.0.1:${AONE_SANDBOX_VNC_PORT}/vnc.html >/dev/null && timeout 2 bash -c '</dev/tcp/127.0.0.1/5900' && timeout 2 bash -c '</dev/tcp/127.0.0.1/${AONE_BOX_EXEC_DAEMON_PORT}'`);
  return result.exitCode === 0;
}

async function waitForDesktop(sandbox: Sandbox, externalVncBaseUrl: string): Promise<void> {
  const deadline = Date.now() + AONE_SANDBOX_DESKTOP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const internalReady = await desktopReady(sandbox);
      const response = await fetch(endpointUrl(externalVncBaseUrl, "vnc.html"), { signal: AbortSignal.timeout(3_000) });
      if (internalReady && response.ok) return;
    } catch {
      // The Aone endpoint and the desktop processes can become ready independently.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Aone Sandbox started, but its visual desktop did not become ready within one minute.");
}

async function ensureDesktopRuntime(sandbox: Sandbox, token: string, suppliedNodePath?: string): Promise<void> {
  const alreadyReady = await desktopReady(sandbox);
  const nodePath = suppliedNodePath ?? await resolveNodePath(sandbox);
  const packageCheck = "command -v Xvfb >/dev/null && command -v x11vnc >/dev/null && command -v websockify >/dev/null && command -v openbox-session >/dev/null && command -v chromium-browser >/dev/null && command -v xdotool >/dev/null && command -v import >/dev/null";
  const packageResult = await sandbox.commands.run(packageCheck);
  if (packageResult.exitCode !== 0) {
    logAoneSandbox("installing visual desktop dependencies");
    const installResult = await sandbox.commands.run(`dnf install -y ${AONE_DESKTOP_PACKAGES.map(shellValue).join(" ")}`, { timeoutSeconds: 300 });
    if (installResult.exitCode !== 0) {
      const stderr = installResult.logs.stderr.map((message) => message.text).join("").trim();
      throw new Error(`Aone Sandbox could not install its visual desktop dependencies${stderr.length === 0 ? "." : `: ${stderr}`}`);
    }
  }
  if (alreadyReady) return;
  await sandbox.files.writeFiles([
    { path: "/opt/onebot/vnc.tokens", data: `${token}: 127.0.0.1:5900\n`, mode: AONE_PRIVATE_FILE_MODE },
    { path: "/opt/onebot/start-desktop.sh", data: desktopStartScript(nodePath), mode: 700 },
  ]);
  const startResult = await sandbox.commands.run("bash /opt/onebot/start-desktop.sh", { timeoutSeconds: 30 });
  if (startResult.exitCode !== 0) {
    const stderr = startResult.logs.stderr.map((message) => message.text).join("").trim();
    throw new Error(`Aone Sandbox could not start its visual desktop${stderr.length === 0 ? "." : `: ${stderr}`}`);
  }
  const externalVncBaseUrl = await sandbox.getEndpointUrl(AONE_SANDBOX_VNC_PORT);
  await waitForDesktop(sandbox, externalVncBaseUrl);
  logAoneSandbox("visual desktop ready");
}

async function stageRuntime(args: {
  readonly sandbox: Sandbox;
  readonly bundle: HostBundle;
  readonly inferenceCredential?: { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number };
  readonly provider: string;
  readonly token: string;
}): Promise<void> {
  const files: Array<{ path: string; data: Uint8Array | string; mode?: number }> = [
    { path: "/opt/onebot/host/host-main.cjs", data: await readFile(args.bundle.path), mode: AONE_PRIVATE_FILE_MODE },
    { path: "/opt/onebot/box-exec-daemon/main.cjs", data: await readFile(args.bundle.boxExecDaemonPath), mode: AONE_PRIVATE_FILE_MODE },
    ...await Promise.all(args.bundle.supportFiles.map(async (file) => ({
      path: `/opt/onebot/host/${file.relativePath}`,
      data: await readFile(file.path),
      mode: AONE_PRIVATE_FILE_MODE,
    }))),
    {
      path: "/opt/onebot/data/settings.json",
      data: `${JSON.stringify({ version: 1, inferenceProvider: args.provider }, null, 2)}\n`,
      mode: AONE_PRIVATE_FILE_MODE,
    },
  ];
  if (args.provider === "codex") files.push({ path: "/opt/onebot/codex-relay.cjs", data: codexRelayServerSource(), mode: AONE_PRIVATE_FILE_MODE });
  if (args.inferenceCredential != null) {
    files.push({
      path: "/opt/onebot/run/inference.json",
      data: `${JSON.stringify({ accessToken: args.inferenceCredential.accessToken, expiresAtMs: args.inferenceCredential.expiresAtMs })}\n`,
      mode: AONE_PRIVATE_FILE_MODE,
    });
  }
  if (args.provider === "codex") {
    files.push({ path: "/root/.codex/auth.json", data: await privateCodexAuth(), mode: AONE_PRIVATE_FILE_MODE });
  }
  const environment = {
    SAND_PACKAGED: "1",
    ONEBOT_BOX_RUNTIME: "aone-sandbox",
    SAND_SINGLE_DESKTOP_VNC: "1",
    SAND_DATA_ROOT: "/opt/onebot/data",
    SAND_BOX_WORKSPACE_ROOT: "/workspace",
    SAND_BOX_TERMINALS_DIRECTORY: "/opt/onebot/terminals",
    SAND_TREE_SITTER_NODE_DEPS: AONE_NODE_DEPS_ROOT,
    NODE_PATH: AONE_NODE_DEPS_ROOT,
    SAND_GATEWAY_BIND_HOST: "0.0.0.0",
    SAND_HOST_PORT: String(AONE_SANDBOX_GATEWAY_PORT),
    SAND_GATEWAY_TOKEN: args.token,
    ...(args.provider === "codex" ? {
      SAND_CODEX_RESPONSES_ENDPOINT: `http://127.0.0.1:${AONE_SANDBOX_CODEX_RELAY_PORT}/proxy`,
      SAND_CODEX_RELAY_TOKEN: args.token,
      SAND_CODEX_RELAY_PORT: String(AONE_SANDBOX_CODEX_RELAY_PORT),
    } : {}),
    ...(args.inferenceCredential == null ? {} : {
      SAND_DEV_INFERENCE_TOKEN_FILE: "/opt/onebot/run/inference.json",
      SAND_BACKEND_URL: args.inferenceCredential.backendUrl,
    }),
  };
  files.push({
    path: "/opt/onebot/gateway.env",
    data: `${Object.entries(environment).map(([name, value]) => `${name}=${shellValue(value)}`).join("\n")}\n`,
    mode: AONE_PRIVATE_FILE_MODE,
  });
  await args.sandbox.commands.run("mkdir -p /opt/onebot/host /opt/onebot/box-exec-daemon /opt/onebot/run /opt/onebot/data /opt/onebot/terminals /workspace /root/.codex");
  await args.sandbox.files.writeFiles(files);
  const nodePath = await resolveNodePath(args.sandbox);
  const npmPath = join(dirname(nodePath), "npm");
  logAoneSandbox("installing Linux runtime dependencies");
  const installResult = await args.sandbox.commands.run(`export PATH=${shellValue(dirname(nodePath))}:$PATH; ${shellValue(npmPath)} install --omit=dev --no-audit --no-fund --prefix /opt/onebot/node-deps tree-sitter@0.21.1 tree-sitter-bash@0.21.0`, { timeoutSeconds: 120 });
  if (installResult.exitCode !== 0) {
    const stderr = installResult.logs.stderr.map((message) => message.text).join("").trim();
    throw new Error(`Aone Sandbox could not install its Linux runtime dependencies${stderr.length === 0 ? "." : `: ${stderr}`}`);
  }
  await ensureDesktopRuntime(args.sandbox, args.token, nodePath);
  if (args.provider === "codex") {
    await args.sandbox.commands.run(`set -a; . /opt/onebot/gateway.env; set +a; exec ${shellValue(nodePath)} /opt/onebot/codex-relay.cjs`, { background: true });
  }
  await args.sandbox.commands.run(`set -a; . /opt/onebot/gateway.env; set +a; exec ${shellValue(nodePath)} /opt/onebot/host/host-main.cjs`, { background: true });
}

async function createSandbox(args: {
  readonly settingsPath: string;
  readonly settings: SandSettingsStore;
  readonly bundle: HostBundle;
  readonly key: string;
  readonly token: string;
  readonly inferenceCredential?: { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number };
}): Promise<Sandbox> {
  logAoneSandbox("creating sandbox");
  const sandbox = await Sandbox.create({
    connectionConfig: connectionConfig(args.key),
    dynamicTemplate: { image: AONE_SANDBOX_IMAGE, entrypoint: "tail -f /dev/null" },
    timeoutSeconds: AONE_SANDBOX_TTL_SECONDS,
    readyTimeoutSeconds: 120,
    metadata: { app: "onebot", runtime: "onebot" },
    env: {
      SAND_SUPERVISOR_ENABLED: "1",
      SAND_BOX_AUTO_UPDATE: "0",
      ONEBOT_BOX_RUNTIME: "aone-sandbox",
      SAND_SINGLE_DESKTOP_VNC: "1",
      SAND_USE_EXISTING_BOX_EXEC_DAEMON: "1",
      SAND_TREE_SITTER_NODE_DEPS: AONE_NODE_DEPS_ROOT,
      NODE_PATH: AONE_NODE_DEPS_ROOT,
      SAND_GATEWAY_BIND_HOST: "0.0.0.0",
      SAND_HOST_PORT: String(AONE_SANDBOX_GATEWAY_PORT),
      SAND_GATEWAY_TOKEN: args.token,
      ...(args.inferenceCredential == null ? {} : {
        SAND_DEV_INFERENCE_TOKEN_FILE: "/run/onebot/inference.json",
        SAND_BACKEND_URL: args.inferenceCredential.backendUrl,
      }),
    },
    resource: { cpu: "4", memory: "8" },
  });
  logAoneSandbox(`sandbox ${sandbox.id} created; staging runtime`);
  try {
    await stageRuntime({ sandbox, bundle: args.bundle, ...(args.inferenceCredential == null ? {} : { inferenceCredential: args.inferenceCredential }), provider: args.settings.getInferenceProvider(), token: args.token });
    await writeState(args.settingsPath, {
      schemaVersion: 2,
      sandboxId: sandbox.id,
      hostSha256: args.bundle.sha256,
      boxExecDaemonSha256: args.bundle.boxExecDaemonSha256,
      provider: args.settings.getInferenceProvider(),
      createdAt: new Date().toISOString(),
    });
    logAoneSandbox(`sandbox ${sandbox.id} runtime staged`);
    return sandbox;
  } catch (error) {
    await sandbox.kill().catch(() => undefined);
    await sandbox.close().catch(() => undefined);
    throw error;
  }
}

let active: { readonly sandbox: Sandbox; readonly state: AoneSandboxState } | undefined;
let connectInFlight: Promise<GatewayConnection> | undefined;

export async function isAoneSandboxConfigured(): Promise<boolean> {
  return (process.env.AONE_SANDBOX_API_KEY?.trim().length ?? 0) > 0
    || (process.env.OPEN_SANDBOX_API_KEY?.trim().length ?? 0) > 0
    || ((await readSecret(AONE_SANDBOX_API_KEY_SECRET))?.trim().length ?? 0) > 0
    || ((await readA1GroundApiKey())?.trim().length ?? 0) > 0;
}

export async function getAoneSandboxStatus(settingsPath: string): Promise<AoneSandboxStatus> {
  const [configured, state] = await Promise.all([isAoneSandboxConfigured(), readState(settingsPath)]);
  return {
    configured,
    running: active != null,
    ready: active != null,
    sandboxId: state?.sandboxId ?? null,
    detail: !configured
      ? "Log in with a1 ground or save an Aone Sandbox API key before switching."
      : active != null
        ? `Aone Sandbox ${active.state.sandboxId} shell, files and visual desktop are connected.`
        : state == null
          ? "Aone Sandbox is configured and will be created when selected."
          : `Aone Sandbox ${state.sandboxId} will reconnect when selected.`,
  };
}

export async function saveAoneSandboxApiKey(value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed.length < 16) throw new Error("Aone Sandbox API key is too short.");
  await writeSecret(AONE_SANDBOX_API_KEY_SECRET, trimmed);
}

export function createAoneSandboxHostConnector(args: {
  readonly remote: SandRemoteHostConnector;
  readonly settings: SandSettingsStore;
  readonly stageCurrentHostBundle: (settingsPath: string) => Promise<HostBundle>;
}): SandRemoteHostConnector {
  const connect = (): Promise<GatewayConnection> => {
    if (connectInFlight == null) connectInFlight = (async () => {
      logAoneSandbox("connect requested");
      const key = await apiKey();
      logAoneSandbox("credential resolved");
      const token = await gatewayToken();
      logAoneSandbox("gateway token resolved");
      const settingsPath = args.settings.settingsPath;
      const bundle = await args.stageCurrentHostBundle(settingsPath);
      logAoneSandbox("host runtime bundle staged");
      const state = await readState(settingsPath);
      const provider = args.settings.getInferenceProvider();
      if (active != null && active.state.hostSha256 === bundle.sha256 && active.state.boxExecDaemonSha256 === bundle.boxExecDaemonSha256 && active.state.provider === provider) {
        const connection = await gatewayConnection(active.sandbox, token);
        if (await gatewayReady(connection.baseUrl, token)) {
          await ensureDesktopRuntime(active.sandbox, token);
          await ensureLocalCodexRelay(active.sandbox, token, provider);
          return connection;
        }
        await active.sandbox.close().catch(() => undefined);
        active = undefined;
      }
      if (state != null && state.hostSha256 === bundle.sha256 && state.boxExecDaemonSha256 === bundle.boxExecDaemonSha256 && state.provider === provider) {
        try {
          const sandbox = await Sandbox.connect({ sandboxId: state.sandboxId, connectionConfig: connectionConfig(key), connectTimeoutSeconds: 60 });
          const connection = await gatewayConnection(sandbox, token);
          if (await gatewayReady(connection.baseUrl, token)) {
            await ensureDesktopRuntime(sandbox, token);
            await ensureLocalCodexRelay(sandbox, token, provider);
            await sandbox.renew(AONE_SANDBOX_TTL_SECONDS).catch(() => undefined);
            active = { sandbox, state };
            return connection;
          }
          await sandbox.close().catch(() => undefined);
        } catch {
          // A persisted sandbox may have expired. A new instance is created below.
        }
      }
      const inferenceCredential = args.remote.issueInferenceCredential == null ? undefined : await Promise.race([
        args.remote.issueInferenceCredential(),
        new Promise<undefined>((resolve) => setTimeout(resolve, OPTIONAL_CREDENTIAL_TIMEOUT_MS)),
      ]);
      logAoneSandbox(inferenceCredential == null ? "continuing without optional inference credential" : "optional inference credential resolved");
      const sandbox = await createSandbox({ settingsPath, settings: args.settings, bundle, key, token, ...(inferenceCredential == null ? {} : { inferenceCredential }) });
      const createdState = await readState(settingsPath);
      if (createdState == null) throw new Error("Aone Sandbox state was not persisted after creation.");
      active = { sandbox, state: createdState };
      const connection = await gatewayConnection(sandbox, token);
      await waitForGateway(connection);
      await ensureLocalCodexRelay(sandbox, token, provider);
      logAoneSandbox(`sandbox ${sandbox.id} gateway ready`);
      return connection;
    })().catch((error: unknown) => {
      console.error("[onebot][aone-sandbox] connect failed", error);
      throw error;
    }).finally(() => { connectInFlight = undefined; });
    return connectInFlight;
  };

  const destroy = async (): Promise<void> => {
    if (active != null) {
      const current = active;
      active = undefined;
      await current.sandbox.kill().catch(() => undefined);
      await current.sandbox.close().catch(() => undefined);
      return;
    }
    const state = await readState(args.settings.settingsPath);
    if (state == null) return;
    const key = await apiKey();
    const sandbox = await Sandbox.connect({ sandboxId: state.sandboxId, connectionConfig: connectionConfig(key), connectTimeoutSeconds: 30 });
    await sandbox.kill().catch(() => undefined);
    await sandbox.close().catch(() => undefined);
  };

  return {
    connect,
    recreate: async (): Promise<RecreateResult> => {
      await destroy();
      await connect();
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      await destroy();
      await connect();
      return { status: "started-untrackable" };
    },
  };
}
