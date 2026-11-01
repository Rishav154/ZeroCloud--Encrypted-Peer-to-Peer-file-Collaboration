import { jwtVerify, SignJWT } from "jose";
import type { NextFunction, Request, Response } from "express";

const ISSUER = "zerocloud";

export type VerifiedSession = { userId: string; expiresAt: number };

export async function createSessionToken(
  userId: string,
  secret: string,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(new TextEncoder().encode(secret));
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<VerifiedSession> {
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(secret),
    { algorithms: ["HS256"], issuer: ISSUER },
  );
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
    throw new Error("Invalid session token");
  }
  return { userId: payload.sub, expiresAt: payload.exp };
}

export function requireSession(secret: string) {
  return async function sessionMiddleware(
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    const authorization = request.header("authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match?.[1]) {
      response.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
      return;
    }
    let session: VerifiedSession;
    try {
      session = await verifySessionToken(match[1], secret);
    } catch {
      response.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Invalid or expired session" },
      });
      return;
    }
    response.locals.authUserId = session.userId;
    next();
  };
}
