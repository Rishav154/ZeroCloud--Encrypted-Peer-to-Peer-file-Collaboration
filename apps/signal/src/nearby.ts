import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";

export function normalizeClientIp(input: string): string {
  const value = input.trim().replace(/^\[|\]$/g, "");
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice(7);
    if (isIP(mapped) === 4) return isLoopbackV4(mapped) ? "loopback" : mapped;
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(mapped)) {
      const parts = mapped.split(":").map((part) => Number.parseInt(part, 16));
      const high = parts[0] ?? 0;
      const low = parts[1] ?? 0;
      const ipv4 = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
      return isLoopbackV4(ipv4) ? "loopback" : ipv4;
    }
  }
  if (isIP(value) === 4) return isLoopbackV4(value) ? "loopback" : value;
  if (isIP(value) !== 6) throw new Error("Invalid client IP address");
  const expanded = expandIpv6(value);
  if (expanded.slice(0, 7).every((part) => part === "0000") && expanded[7] === "0001") return "loopback";
  return `${expanded.slice(0, 4).join(":")}:0000:0000:0000:0000`;
}

function isLoopbackV4(value: string): boolean {
  return value.split(".")[0] === "127";
}

function expandIpv6(value: string): string[] {
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = value.slice(lastColon + 1).split(".").map((part) => Number.parseInt(part, 10));
    if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const first = (((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0)).toString(16);
      const second = (((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0)).toString(16);
      value = `${value.slice(0, lastColon + 1)}${first}:${second}`;
    }
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const fill = Array(Math.max(0, 8 - left.length - right.length)).fill("0") as string[];
  return [...left, ...fill, ...right].map((part) => part.padStart(4, "0").toLowerCase());
}

export function nearbyGroupKey(secret: string, ip: string): string {
  return createHmac("sha256", secret).update(normalizeClientIp(ip)).digest("hex");
}

export function deriveClientIp(xff: string | string[] | undefined, socketAddress: string | undefined, hops: number): string {
  const socketIp = socketAddress ?? "unknown";
  if (hops === 0 || !xff) return socketIp;
  const chain = (Array.isArray(xff) ? xff.join(",") : xff).split(",").map((item) => item.trim()).filter(Boolean);
  return chain[chain.length - hops] ?? socketIp;
}

export function withinWindow(timestamps: number[], now: number, windowMs: number): number[] {
  return timestamps.filter((time) => now - time < windowMs);
}

export function rawPublicKeyFingerprint(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}
