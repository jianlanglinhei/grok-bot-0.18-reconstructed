import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function parseA1GroundApiKey(source: string): string | undefined {
  const raw = /^sandbox_api_key:\s*(.+?)\s*$/mu.exec(source)?.[1]?.trim();
  if (raw == null || raw.length === 0) return undefined;
  const unquoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
    ? raw.slice(1, -1).trim()
    : raw;
  return unquoted.length >= 16 ? unquoted : undefined;
}

export async function readA1GroundApiKey(path = join(homedir(), ".config", "a1", "ground.yaml")): Promise<string | undefined> {
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) return undefined;
    return parseA1GroundApiKey(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}
