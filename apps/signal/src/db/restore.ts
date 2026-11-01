import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isAbsolute, resolve } from "node:path";
import { config } from "../config.js";

dotenv.config({ path: "../../.env" });
const input = process.argv[2];
if (!input) throw new Error("Usage: pnpm db:restore -- <dump-file>");
const filename = isAbsolute(input) ? input : resolve(process.cwd(), input);
const prompt = createInterface({ input: stdin, output: stdout });
const confirmation = await prompt.question(`Restore ${filename} into ${new URL(config.DIRECT_DATABASE_URL).host}/${new URL(config.DIRECT_DATABASE_URL).pathname.slice(1)} and replace existing objects? Type RESTORE to continue: `);
prompt.close();
if (confirmation !== "RESTORE") {
  process.stdout.write("Restore cancelled.\n");
  process.exit(0);
}
await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", config.DIRECT_DATABASE_URL, filename]);
process.stdout.write("Restore completed.\n");

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code ?? "unknown"}`)));
  });
}
