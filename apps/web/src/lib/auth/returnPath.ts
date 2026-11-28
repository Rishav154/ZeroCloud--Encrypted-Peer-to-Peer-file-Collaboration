export function getPostAuthPath(): string {
  if (typeof window === "undefined") return "/workspaces";
  const candidate = new URLSearchParams(window.location.search).get("returnTo");
  return candidate && candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/workspaces";
}
