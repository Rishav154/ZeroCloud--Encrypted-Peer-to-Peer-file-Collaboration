"use client";
import { useCallback, useEffect, useRef } from "react";
import { publicConfig } from "../lib/config";
const configured = publicConfig.NEXT_PUBLIC_SIGNAL_URL;
const socketUrl = configured.replace(/^http/, "ws").replace(/\/ws\/?$/, "").replace(/\/$/, "") + "/ws/nearby";
export function useAnonymousNearbySocket(onMessage: (message: unknown) => void, onOpen: () => void, active: boolean, onDisconnect: () => void) {
  const ref = useRef<WebSocket | null>(null);
  const callbacks = useRef({ onMessage, onOpen, onDisconnect }); callbacks.current = { onMessage, onOpen, onDisconnect };
  useEffect(() => {
    if (!active) return;
    let disposed = false; let hidden = false; let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = (): void => {
      if (disposed) return;
      const socket = new WebSocket(socketUrl); ref.current = socket;
      socket.addEventListener("open", () => callbacks.current.onOpen());
      socket.addEventListener("message", (event) => { if (typeof event.data === "string") { try { callbacks.current.onMessage(JSON.parse(event.data) as unknown); } catch { /* Ignore malformed server frames. */ } } });
      socket.addEventListener("close", () => { callbacks.current.onDisconnect(); if (!disposed && !hidden) retry = setTimeout(connect, 1000); });
    };
    const pagehide = (): void => { hidden = true; const socket = ref.current; if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "nearby-disable" })); socket?.close(1000, "Page hidden"); };
    const pageshow = (): void => { if (document.visibilityState === "visible" && hidden && !disposed) { hidden = false; connect(); } };
    const visibility = (): void => { if (document.visibilityState === "visible") pageshow(); };
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    document.addEventListener("visibilitychange", visibility);
    connect();
    return () => { disposed = true; window.removeEventListener("pagehide", pagehide); window.removeEventListener("pageshow", pageshow); document.removeEventListener("visibilitychange", visibility); if (retry) clearTimeout(retry); ref.current?.close(1000, "Nearby screen closed"); ref.current = null; };
  }, [active]);
  const send = useCallback((message: unknown): boolean => { const socket = ref.current; if (!socket || socket.readyState !== WebSocket.OPEN) return false; socket.send(JSON.stringify(message)); return true; }, []);
  return { send, socket: ref };
}
