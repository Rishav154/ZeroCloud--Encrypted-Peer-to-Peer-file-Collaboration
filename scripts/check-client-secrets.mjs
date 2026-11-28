import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = join(root, "apps/web/.next");
const secretNames = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "TEST_DATABASE_URL",
  "JWT_SECRET",
  "TURN_PROVIDER_SECRET",
  "ICE_STATIC_USERNAME",
  "ICE_STATIC_CREDENTIAL",
];
// NEXT_PUBLIC_* configuration is intentionally visible to browsers; only scan
// server-only secret values here, not the names of public configuration keys.
const values = new Map();
for (const name of secretNames) {
  const value = process.env[name];
  if (value && value.length >= 8) values.set(name, value);
}
for (const filename of [".env", ".env.production", ".env.local"]) {
  try {
    const contents = await readFile(join(root, filename), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match?.[1] || !match[2] || !secretNames.includes(match[1])) continue;
      const value = match[2].replace(/^['"]|['"]$/g, "");
      if (value.length >= 8) values.set(match[1], value);
    }
  } catch {
    // Optional local env files are absent in CI and on deploy hosts.
  }
}

const files = await listFiles(outputDirectory);
const failures = [];
for (const filename of files) {
  const contents = await readFile(filename);
  const text = contents.toString("utf8");
  for (const [name, value] of values) {
    if (text.includes(value)) failures.push(`${relative(root, filename)} contains a value from ${name}`);
  }
}
if (failures.length) {
  process.stderr.write(`Client bundle secret scan failed:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Client bundle secret scan passed (${files.length} build files checked).\n`);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && (entry.name === "dev" || entry.name === "cache")) return [];
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}
