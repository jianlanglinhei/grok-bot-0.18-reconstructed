import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source", "electron-main", "box", "aone-sandbox-vnc.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("Aone Sandbox noVNC URL authenticates and reconnects the right-side desktop", async () => {
  const { buildAoneNoVncUrl } = await loadModule();
  const url = new URL(buildAoneNoVncUrl("https://desktop.example.test/base", "private-token"));
  assert.equal(url.origin, "https://desktop.example.test");
  assert.equal(url.pathname, "/base/vnc.html");
  assert.equal(url.searchParams.get("autoconnect"), "1");
  assert.equal(url.searchParams.get("resize"), "scale");
  assert.equal(url.searchParams.get("network_token"), "private-token");
  assert.equal(url.searchParams.get("path"), "websockify?token=private-token");
});
