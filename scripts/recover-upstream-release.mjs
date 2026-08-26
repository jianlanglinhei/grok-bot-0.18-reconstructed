#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { extractAll } from "@electron/asar";
import { transform } from "esbuild";

import { repoRoot, upstreamVersion } from "./lib/config.mjs";
import { resolveRuntimeApp } from "./lib/runtime.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function walkFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return files.sort();
}

function isApplicationPayload(relative) {
  if (relative === "package.json") return true;
  if (!relative.startsWith("dist/")) return false;
  if (relative.startsWith("dist/deps/") || relative.startsWith("dist/native/")) return false;
  return [".cjs", ".js", ".json", ".html", ".css"].includes(path.extname(relative));
}

function transformOptions(relative) {
  const renderer = relative.startsWith("dist/renderer/");
  return {
    charset: "utf8",
    format: renderer ? "esm" : "cjs",
    legalComments: "inline",
    loader: "js",
    minify: false,
    sourcefile: relative,
    sourcemap: false,
    target: renderer ? "es2022" : "node22",
  };
}

export async function recoverUpstreamRelease({
  outputRoot = path.join(repoRoot, "recovered", "upstream", upstreamVersion),
} = {}) {
  const runtimeApp = await resolveRuntimeApp();
  const archive = path.join(runtimeApp, "Contents", "Resources", "app.asar");
  const archiveBytes = await readFile(archive);
  const extractionRoot = await mkdtemp(path.join(tmpdir(), `onebot-recover-${upstreamVersion.replaceAll(".", "-")}-`));
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  try {
    extractAll(archive, extractionRoot);
    const packageJson = JSON.parse(await readFile(path.join(extractionRoot, "package.json"), "utf8"));
    if (packageJson.version !== upstreamVersion) {
      throw new Error(`Expected upstream ${upstreamVersion}, extracted ${String(packageJson.version)}`);
    }

    const extractedFiles = await walkFiles(extractionRoot);
    const sourceMaps = extractedFiles.filter(relative => relative.endsWith(".map"));
    const recovered = [];
    for (const relative of extractedFiles.filter(isApplicationPayload)) {
      const sourcePath = path.join(extractionRoot, relative);
      const destination = path.join(outputRoot, relative);
      const source = await readFile(sourcePath);
      await mkdir(path.dirname(destination), { recursive: true });
      let output = source;
      let mode = "copied";
      if (relative.endsWith(".js") || relative.endsWith(".cjs")) {
        const transformed = await transform(source.toString("utf8"), transformOptions(relative));
        output = Buffer.from(transformed.code);
        mode = "esbuild-readable-print";
      }
      await writeFile(destination, output);
      recovered.push({
        path: relative,
        mode,
        input: { bytes: source.byteLength, sha256: sha256(source) },
        output: { bytes: output.byteLength, sha256: sha256(output) },
      });
    }

    const manifest = {
      schemaVersion: 1,
      upstreamVersion,
      upstreamAppAsar: { bytes: archiveBytes.byteLength, sha256: sha256(archiveBytes) },
      sourceMaps: { present: sourceMaps.length > 0, files: sourceMaps },
      recovery: {
        semantics: "parse-and-readable-print",
        limitation: "Minification removed authored names, comments, module layout, and TypeScript types; those cannot be recovered exactly without upstream source maps.",
        fileCount: recovered.length,
        files: recovered,
      },
    };
    await writeFile(path.join(outputRoot, "recovery-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { outputRoot, manifest };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

const result = await recoverUpstreamRelease();
console.log(`Readable upstream ${upstreamVersion} payload: ${result.outputRoot}`);
console.log(`Recovered ${result.manifest.recovery.fileCount} application files; source maps present: ${result.manifest.sourceMaps.present}`);
