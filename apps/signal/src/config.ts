import dotenv from "dotenv";
import { parseEnvironment } from "./environment.js";

dotenv.config({ path: "../../.env" });

export { environmentSchema, parseEnvironment } from "./environment.js";
export type { AppConfig } from "./environment.js";
export const config = parseEnvironment(process.env);
