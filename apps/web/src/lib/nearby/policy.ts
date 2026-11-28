export type ClickAction = "offer" | "connect-request" | "ignore";
export type RequestDecision = "accept" | "ignore" | "rate-limited" | "blocked" | "connection-limit";
export type OfferDecision = "accept" | "blocked" | "pending-limit" | "rate-limited";

export function nearbyClickAction(localPeerId: string, remotePeerId: string, attemptInProgress: boolean): ClickAction {
  if (attemptInProgress) return "ignore";
  return localPeerId < remotePeerId ? "offer" : "connect-request";
}

export function connectRequestDecision(input: { enabled: boolean; listed: boolean; localPeerId: string; remotePeerId: string; blocked: boolean; connections: number; requestsInLastMinute: number; attemptInProgress: boolean }): RequestDecision {
  if (!input.enabled || !input.listed || input.localPeerId > input.remotePeerId || input.attemptInProgress) return "ignore";
  if (input.blocked) return "blocked";
  if (input.requestsInLastMinute >= 5) return "rate-limited";
  if (input.connections >= 8) return "connection-limit";
  return "accept";
}

export function nearbyOfferDecision(input: { blocked: boolean; pendingOffers: number; offersInLastMinute: number }): OfferDecision {
  if (input.blocked) return "blocked";
  if (input.pendingOffers >= 3) return "pending-limit";
  if (input.offersInLastMinute >= 10) return "rate-limited";
  return "accept";
}

export function requiresUnverifiedInviteConfirmation(isVerified: boolean): boolean { return !isVerified; }
