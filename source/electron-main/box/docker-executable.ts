import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

const MACOS_DOCKER_LOCATIONS = [
  "/opt/homebrew/bin/docker",
  "/usr/local/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
] as const;

export function dockerExecutableCandidates(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  const pathCandidates = (environment.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => join(entry, "docker"));
  return [...new Set([
    environment.ONEBOT_DOCKER_PATH,
    environment.SAND_DOCKER_PATH,
    ...pathCandidates,
    ...(process.platform === "darwin" ? MACOS_DOCKER_LOCATIONS : []),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0))];
}

export async function resolveDockerExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates = dockerExecutableCandidates(environment);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Docker CLI was not found. Checked: ${candidates.join(", ") || "no executable paths"}. Install Docker or Colima, or set ONEBOT_DOCKER_PATH.`);
}
