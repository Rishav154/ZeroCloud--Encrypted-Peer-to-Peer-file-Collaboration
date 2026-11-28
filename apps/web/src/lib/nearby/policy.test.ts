import { describe, expect, it } from "vitest";
import { connectRequestDecision, nearbyClickAction, nearbyOfferDecision, requiresUnverifiedInviteConfirmation } from "./policy";

describe("nearby offerer and request policy", () => {
  const smaller = "00000000-0000-4000-8000-000000000001";
  const larger = "00000000-0000-4000-8000-000000000002";
  it("makes larger-peer clicks request the single offer from the smaller peer", () => {
    expect(nearbyClickAction(larger, smaller, false)).toBe("connect-request");
    expect(nearbyClickAction(smaller, larger, false)).toBe("offer");
    const simultaneousOffers = [nearbyClickAction(smaller, larger, false), nearbyClickAction(larger, smaller, false)].filter((action) => action === "offer");
    expect(simultaneousOffers).toHaveLength(1);
    expect(nearbyClickAction(smaller, larger, true)).toBe("ignore");
  });
  it("ignores duplicate, blocked, over-rate, and ninth concurrent requests", () => {
    const base = { enabled: true, listed: true, localPeerId: smaller, remotePeerId: larger, blocked: false, connections: 0, requestsInLastMinute: 0, attemptInProgress: false };
    expect(connectRequestDecision({ ...base, attemptInProgress: true })).toBe("ignore");
    expect(connectRequestDecision({ ...base, blocked: true })).toBe("blocked");
    expect(connectRequestDecision({ ...base, requestsInLastMinute: 5 })).toBe("rate-limited");
    expect(connectRequestDecision({ ...base, connections: 8 })).toBe("connection-limit");
  });
  it("declines the fourth pending offer, the eleventh per minute, and blocked fingerprints", () => {
    expect(nearbyOfferDecision({ blocked: false, pendingOffers: 3, offersInLastMinute: 0 })).toBe("pending-limit");
    expect(nearbyOfferDecision({ blocked: false, pendingOffers: 0, offersInLastMinute: 10 })).toBe("rate-limited");
    expect(nearbyOfferDecision({ blocked: true, pendingOffers: 0, offersInLastMinute: 0 })).toBe("blocked");
  });
  it("requires an extra workspace invite confirmation for unverified peers", () => {
    expect(requiresUnverifiedInviteConfirmation(false)).toBe(true);
    expect(requiresUnverifiedInviteConfirmation(true)).toBe(false);
  });
});
