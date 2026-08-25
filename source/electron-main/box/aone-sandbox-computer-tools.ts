export const AONE_COMPUTER_PROVIDER_IDENTIFIER = "onebot-computer";
export const AONE_BROWSER_OPEN_TOOL_NAME = "onebot_browser_open";
export const AONE_COMPUTER_SCREENSHOT_TOOL_NAME = "onebot_computer_screenshot";

export type AoneRoutedComputerTool = {
  readonly name: string;
  readonly providerIdentifier: typeof AONE_COMPUTER_PROVIDER_IDENTIFIER;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

export function listAoneRoutedComputerTools(): readonly AoneRoutedComputerTool[] {
  return [
    {
      name: AONE_BROWSER_OPEN_TOOL_NAME,
      providerIdentifier: AONE_COMPUTER_PROVIDER_IDENTIFIER,
      toolName: AONE_BROWSER_OPEN_TOOL_NAME,
      description: "Open an HTTP(S) URL, or search for a named site or app, in the visible Chromium window on onebot's selected Aone Sandbox computer. Returns the resulting desktop screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "An http(s) URL, domain, or site/app name to open." },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
    {
      name: AONE_COMPUTER_SCREENSHOT_TOOL_NAME,
      providerIdentifier: AONE_COMPUTER_PROVIDER_IDENTIFIER,
      toolName: AONE_COMPUTER_SCREENSHOT_TOOL_NAME,
      description: "Capture the current visible desktop of onebot's selected Aone Sandbox computer.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

export function resolveAoneBrowserTarget(raw: string): string {
  const target = raw.trim();
  if (target.length === 0 || target.length > 2_048) throw new Error("Browser target must contain between 1 and 2048 characters.");
  let parsed: URL;
  try { parsed = new URL(target); }
  catch {
    if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(?:\/.*)?$/iu.test(target)) return `https://${target}`;
    return `https://www.baidu.com/s?wd=${encodeURIComponent(target)}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP(S) browser targets are supported.");
  return parsed.toString();
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildAoneBrowserOpenCommand(url: string): string {
  return [
    "set -e",
    "window_id=$(DISPLAY=:0 xdotool search --onlyvisible --class chromium | head -n 1)",
    "test -n \"$window_id\"",
    "DISPLAY=:0 xdotool windowactivate --sync \"$window_id\"",
    "sleep 0.3",
    "DISPLAY=:0 xdotool key --clearmodifiers ctrl+l",
    "sleep 0.2",
    `DISPLAY=:0 xdotool type --clearmodifiers --delay 1 -- ${shellValue(url)}`,
    "DISPLAY=:0 xdotool key --clearmodifiers Return",
    "sleep 4",
  ].join("; ");
}

export function isTransientAoneConnectionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  const parts: string[] = [];
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) parts.push(current.name, current.message);
    if (typeof current === "object") {
      const code = Reflect.get(current, "code");
      if (typeof code === "string") parts.push(code);
      current = Reflect.get(current, "cause");
    } else break;
  }
  return /(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network|timeout|socket)/iu.test(parts.join(" "));
}

export function routedComputerSuccess(contents: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string })[]): Record<string, unknown> {
  return {
    result: {
      case: "success",
      value: {
        isError: false,
        content: contents.map(content => content.type === "text"
          ? { content: { case: "text", value: { text: content.text } } }
          : { content: { case: "image", value: { data: content.data, mimeType: content.mimeType } } }),
      },
    },
  };
}
