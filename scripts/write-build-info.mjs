import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

let sha = process.env.BUILD_SHA ?? process.env.RENDER_GIT_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA;
if (!sha) {
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    sha = "local";
  }
}
const builtAt = process.env.BUILD_TIME ?? new Date().toISOString();
const contents = `export const buildInfo = { sha: ${JSON.stringify(sha)}, time: ${JSON.stringify(builtAt)} } as const;\n`;
await writeFile(new URL("../apps/signal/src/build-info.generated.ts", import.meta.url), contents, "utf8");
