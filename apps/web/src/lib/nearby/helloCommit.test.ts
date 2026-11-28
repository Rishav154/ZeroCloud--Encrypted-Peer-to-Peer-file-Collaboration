import { describe, expect, it } from "vitest";
import { commitHello, verifyHelloCommit } from "./helloCommit";

describe("nearby hello commitment", () => {
  it("accepts the exact committed hello and rejects tampering", async () => {
    const hello = JSON.stringify({ type: "hello", v: 1, alg: "P-256", publicKey: "a2V5", nonce: "bm9uY2U=" });
    const commitment = await commitHello(hello);
    expect(await verifyHelloCommit(hello, commitment)).toBe(true);
    expect(await verifyHelloCommit(hello.replace("bm9uY2U=", "b3RoZXI="), commitment)).toBe(false);
  });

  it("prevents a relay from changing its nonce after the victim hello is revealed", async () => {
    const attackerHelloCommittedBeforehand = JSON.stringify({ type: "hello", v: 1, alg: "P-256", publicKey: "attacker-key", nonce: "chosen-before-victim-hello" });
    const commitment = await commitHello(attackerHelloCommittedBeforehand);
    const victimHello = JSON.stringify({ type: "hello", v: 1, alg: "P-256", publicKey: "victim-key", nonce: "victim-nonce" });
    const attackerHelloWithGroundNonce = JSON.stringify({ type: "hello", v: 1, alg: "P-256", publicKey: "attacker-key", nonce: `selected-after-${victimHello}` });
    expect(await verifyHelloCommit(attackerHelloWithGroundNonce, commitment)).toBe(false);
  });
});
