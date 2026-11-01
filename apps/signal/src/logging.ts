import pino, { type LoggerOptions } from "pino";
import { createRequire } from "node:module";
import type { HttpLogger, Options } from "pino-http";
import type { Request, Response } from "express";
import type { Writable } from "node:stream";
import { randomUUID } from "node:crypto";

export const sensitiveLogPaths = [
  "req.headers.authorization",
  "request.headers.authorization",
  "request.body.password",
  "request.body.token",
  "request.body.wrappedKey",
  "request.body.sealed",
  "request.body.secret",
  "request.body.nameSealed",
  "authorization",
  "password",
  "token",
  "wrappedKey",
  "sealed",
  "secret",
  "nameSealed",
] as const;

export function createLogger(destination?: Writable) {
  const options: LoggerOptions = {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    redact: { paths: [...sensitiveLogPaths], censor: "[REDACTED]" },
  };
  return pino(options, destination);
}

export const logger = createLogger();

const require = createRequire(import.meta.url);
type PinoHttpFactory = (options: Options<Request, Response>) => HttpLogger<Request, Response>;
const pinoHttp = require("pino-http") as unknown as PinoHttpFactory;

export const httpLogger = pinoHttp({
  logger,
  genReqId: (_request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    return requestId;
  },
  customLogLevel: (_request, response, error) => {
    if (error || response.statusCode >= 500) return "error";
    if (response.statusCode >= 400) return "warn";
    return "info";
  },
});
