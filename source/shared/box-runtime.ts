export type SandBoxRuntime = "remote" | "local-docker" | "aone-sandbox";

export const DEFAULT_SAND_BOX_RUNTIME: SandBoxRuntime = "remote";

export function isSandBoxRuntime(value: unknown): value is SandBoxRuntime {
  return value === "remote" || value === "local-docker" || value === "aone-sandbox";
}
