import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source", "electron-main", "box", "docker-executable.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("Docker executable discovery repairs the reduced PATH used by macOS GUI apps", async () => {
  const { dockerExecutableCandidates } = await loadModule();
  const candidates = dockerExecutableCandidates({
    ONEBOT_DOCKER_PATH: "/custom/onebot/docker",
    SAND_DOCKER_PATH: "/custom/sand/docker",
    PATH: "/usr/bin:/bin",
  });

  assert.deepEqual(candidates.slice(0, 4), [
    "/custom/onebot/docker",
    "/custom/sand/docker",
    "/usr/bin/docker",
    "/bin/docker",
  ]);
  if (process.platform === "darwin") {
    assert.ok(candidates.includes("/opt/homebrew/bin/docker"));
    assert.ok(candidates.includes("/usr/local/bin/docker"));
    assert.ok(candidates.includes("/Applications/Docker.app/Contents/Resources/bin/docker"));
  }
});

test("Docker executable discovery removes duplicate candidates", async () => {
  const { dockerExecutableCandidates } = await loadModule();
  const candidates = dockerExecutableCandidates({
    ONEBOT_DOCKER_PATH: "/usr/bin/docker",
    PATH: "/usr/bin:/usr/bin",
  });
  assert.equal(candidates.filter((candidate) => candidate === "/usr/bin/docker").length, 1);
});
