import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

dotenv.config({ path: "../../.env" });
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const directory = join(root, "backups");
await mkdir(directory, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = join(directory, `zerocloud-${timestamp}.dump`);
await run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", output, config.DIRECT_DATABASE_URL]);
process.stdout.write(`Backup written to ${output}\n`);

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? "unknown"}`)));
  });
}
