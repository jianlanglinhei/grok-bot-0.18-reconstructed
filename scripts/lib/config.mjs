import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(thisDir, "../..");
export const sourceAppDir = path.join(repoRoot, "src", "app");
export const cacheDir = path.join(repoRoot, ".cache");
export const cachedRuntimeApp = path.join(cacheDir, "runtime", "Grok Bot.app");
export const cachedDmg = path.join(cacheDir, "downloads", "Grok_Bot_0.24.0.dmg");
export const archivedDmg = path.join(repoRoot, "research-archives", "original", "0.24.0", "macos-arm64", "Grok_Bot_0.24.0.dmg");
export const buildDir = path.join(repoRoot, ".build");
export const stagedAppDir = path.join(buildDir, "app");
export const builtAsar = path.join(buildDir, "app.asar");
export const builtAsarUnpacked = `${builtAsar}.unpacked`;
export const fidelityBuildDir = path.join(buildDir, "fidelity");
export const fidelityStagedAppDir = path.join(fidelityBuildDir, "app");
export const fidelityBuiltAsar = path.join(fidelityBuildDir, "app.asar");
export const fidelityBuiltAsarUnpacked = `${fidelityBuiltAsar}.unpacked`;
export const fidelityCandidateManifest = path.join(fidelityBuildDir, "release-candidate.json");
export const fidelityE2ECandidateManifest = path.join(fidelityBuildDir, "e2e-candidate.json");
export const fidelityReleaseEvidenceDir = path.join(fidelityBuildDir, "release-evidence");
export const outputDir = path.join(repoRoot, "dist");
const configuredOutputName = process.env.ONEBOT_OUTPUT_APP_NAME?.trim();
export const outputApp = path.join(
  outputDir,
  configuredOutputName ? path.basename(configuredOutputName) : "onebot.app"
);
export const fidelityOutputApp = path.join(outputDir, "onebot 0.24 Fidelity.app");
export const fidelityOutputAppForAsarHash = asarHash => {
  if (!/^[0-9a-f]{64}$/.test(asarHash)) throw new TypeError("A full lowercase ASAR SHA-256 is required");
  return path.join(outputDir, `onebot 0.24 Fidelity-${asarHash.slice(0, 12)}.app`);
};
export const fidelityInstalledAppForAsarHash = asarHash => path.join("/Applications", path.basename(fidelityOutputAppForAsarHash(asarHash)));
export const recoveredFrontendDir = path.join(repoRoot, "recovered", "frontend");
export const recoveredRendererDir = path.join(recoveredFrontendDir, "app");
export const frontendDir = path.join(repoRoot, "frontend");
export const devOutputApp = path.join(outputDir, "onebot 0.24 Dev.app");
export const devProfileDir = path.join(cacheDir, "dev-profile");

export const upstreamVersion = "0.24.0";
export const reconstructedBundleId = "com.jianlanglinhei.onebot";
export const reconstructedName = "onebot";
export const fidelityBundleId = "com.jianlanglinhei.onebot.fidelity";
export const fidelityName = "onebot 0.24 Fidelity";
export const dmgUrl = "https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.24.0/Grok_Bot_0.24.0.dmg";
export const dmgSha256 = "255873da42d2f19b27d7f34cdfb5b058002095ade883d8b321d6494f3cf6c615";
export const upstreamAsarSha256 = "41f7d5008db4edcb198d9e466c9c1e776bb8a75a7651951257ff9a4f885a4540";
