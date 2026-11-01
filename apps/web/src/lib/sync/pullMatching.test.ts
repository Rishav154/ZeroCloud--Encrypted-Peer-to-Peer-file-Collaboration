import { describe, expect, it } from "vitest";
import { classifyPullOffer } from "./pullMatching";

const expected = {
  requestId: "00000000-0000-4000-8000-000000000001",
  size: 123,
  sha256: "a".repeat(64),
};

describe("classifyPullOffer", () => {
  it("does not auto-accept unsolicited sync offers", () => {
    expect(classifyPullOffer({ purpose: "sync", ...expected }, undefined)).toBe(
      "manual",
    );
  });

  it("auto-accepts only an offer with the matching request ID, size, and hash", () => {
    expect(classifyPullOffer({ purpose: "sync", ...expected }, expected)).toBe(
      "auto-accept",
    );
    expect(
      classifyPullOffer(
        { purpose: "sync", ...expected, size: expected.size + 1 },
        expected,
      ),
    ).toBe("reject");
    expect(
      classifyPullOffer(
        { purpose: "sync", ...expected, sha256: "b".repeat(64) },
        expected,
      ),
    ).toBe("reject");
  });

  it("keeps ordinary file offers on the manual Quick send path", () => {
    expect(
      classifyPullOffer(
        { size: expected.size, sha256: expected.sha256 },
        expected,
      ),
    ).toBe("manual");
  });
});
