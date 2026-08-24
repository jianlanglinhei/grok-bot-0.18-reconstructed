function endpointUrl(value: string, suffix = ""): string {
  const base = value.endsWith("/") ? value : `${value}/`;
  return suffix.length === 0 ? base.slice(0, -1) : new URL(suffix.replace(/^\//u, ""), base).toString();
}

export function buildAoneNoVncUrl(baseUrl: string, token: string): string {
  const url = new URL(endpointUrl(baseUrl, "vnc.html"));
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("network_token", token);
  url.searchParams.set("path", `websockify?token=${token}`);
  return url.toString();
}
