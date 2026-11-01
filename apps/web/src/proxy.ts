import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy } from "./lib/security/csp";

export function proxy(request: NextRequest) {
  const nonce = randomBytes(18).toString("base64");
  const csp = buildContentSecurityPolicy(nonce, {
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    signalUrl: process.env.NEXT_PUBLIC_SIGNAL_URL,
    iceUrls: process.env.NEXT_PUBLIC_ICE_URLS,
    production: process.env.NODE_ENV === "production",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

