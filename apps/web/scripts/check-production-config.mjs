import { pathToFileURL } from "node:url";

export function validateProductionSignalUrl(environment) {
  const production = environment.VERCEL_ENV === "production" ||
    environment.DEPLOY_ENV === "production" ||
    environment.NODE_ENV === "production";
  if (!production) return;
  const raw = environment.NEXT_PUBLIC_SIGNAL_URL;
  if (!raw) throw new Error("NEXT_PUBLIC_SIGNAL_URL is required for a production web build");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("NEXT_PUBLIC_SIGNAL_URL must be a valid URL");
  }
  if (parsed.protocol !== "wss:") {
    throw new Error("NEXT_PUBLIC_SIGNAL_URL must use wss:// in production");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateProductionSignalUrl(process.env);
}
