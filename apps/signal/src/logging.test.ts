import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logging.js";

describe("structured log redaction", () => {
  it("redacts sensitive fields from a sample request", () => {
    let output = "";
    const destination = new Writable({
      write(chunk: Uint8Array, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger(destination);
    logger.info({
      request: {
        headers: { authorization: "Bearer authorization-secret" },
        body: {
          password: "password-secret",
          token: "token-secret",
          wrappedKey: "wrapped-key-secret",
          sealed: "sealed-secret",
          secret: "invite-secret",
          nameSealed: "workspace-name-secret",
        },
      },
    }, "sample request");

    for (const value of [
      "authorization-secret",
      "password-secret",
      "token-secret",
      "wrapped-key-secret",
      "sealed-secret",
      "invite-secret",
      "workspace-name-secret",
    ]) {
      expect(output).not.toContain(value);
    }
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(7);
  });
});
