import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source", "electron-main", "box", "aone-sandbox-credential.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("Aone Sandbox credential parser accepts a1 ground YAML without exposing unrelated fields", async () => {
  const { parseA1GroundApiKey } = await loadModule();
  assert.equal(parseA1GroundApiKey("sandbox_api_key: abcdefghijklmnop\nsandbox_tenant: example\n"), "abcdefghijklmnop");
  assert.equal(parseA1GroundApiKey("sandbox_api_key: 'abcdefghijklmnop'\n"), "abcdefghijklmnop");
  assert.equal(parseA1GroundApiKey("sandbox_tenant: example\n"), undefined);
  assert.equal(parseA1GroundApiKey("sandbox_api_key: short\n"), undefined);
});
