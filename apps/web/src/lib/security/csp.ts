type CspEnvironment = {
  apiUrl?: string | undefined;
  signalUrl?: string | undefined;
  iceUrls?: string | undefined;
  production: boolean;
};

export function buildContentSecurityPolicy(nonce: string, environment: CspEnvironment): string {
  const connectSources = new Set<string>(["'self'"]);
  addOrigin(connectSources, environment.apiUrl);
  addSignalOrigins(connectSources, environment.signalUrl);
  for (const iceUrl of (environment.iceUrls ?? "").split(",")) {
    const source = cspIceSource(iceUrl.trim());
    if (source) connectSources.add(source);
  }
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${environment.production ? "" : " 'unsafe-eval'"}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${Array.from(connectSources).join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(environment.production ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

function addOrigin(sources: Set<string>, raw: string | undefined): void {
  if (!raw) return;
  try {
    sources.add(new URL(raw).origin);
  } catch {
    throw new Error("CSP origin configuration must contain valid URLs");
  }
}

function addSignalOrigins(sources: Set<string>, raw: string | undefined): void {
  if (!raw) return;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "wss:") {
      sources.add(`wss://${parsed.host}`);
      sources.add(`https://${parsed.host}`);
      return;
    }
    if (parsed.protocol === "ws:") {
      sources.add(`ws://${parsed.host}`);
      sources.add(`http://${parsed.host}`);
      return;
    }
    throw new Error("invalid signalling protocol");
  } catch {
    throw new Error("CSP signalling configuration must contain a valid ws or wss URL");
  }
}

function cspIceSource(raw: string): string | null {
  if (!raw) return null;
  const match = /^(stun|turn|turns?):([^?]+)(?:\?.*)?$/.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  const protocol = match[1] === "turns" ? "turns" : match[1];
  try {
    const address = new URL(`${protocol}://${match[2]}`);
    return `${protocol}://${address.host}`;
  } catch {
    return null;
  }
}
