"use client";

import { useCallback, useEffect, useRef } from "react";
import { parseMessage, type PingMessage } from "@zerocloud/shared";
import { useSignalStore } from "../lib/signal-store";

const signalUrl =
  process.env.NEXT_PUBLIC_SIGNAL_URL ?? "ws://localhost:4000/ws";

export function useSignalSocket(): { sendPing: () => void } {
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const pendingPingRef = useRef<number | null>(null);
  const setStatus = useSignalStore((state) => state.setStatus);
  const setRoundTripMs = useSignalStore((state) => state.setRoundTripMs);

  useEffect(() => {
    let stopped = false;
    const connect = (): void => {
      if (stopped) return;
      setStatus("connecting");
      const socket = new WebSocket(signalUrl);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        attemptRef.current = 0;
        setStatus("connected");
      });
      socket.addEventListener("message", (event: MessageEvent<string>) => {
        const parsed = parseMessage(event.data);
        if (parsed.success && parsed.data.type === "pong") {
          if (pendingPingRef.current === parsed.data.ts) {
            setRoundTripMs(Date.now() - parsed.data.ts);
            pendingPingRef.current = null;
          }
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (stopped) return;
        setStatus("disconnected");
        const delay = Math.min(1000 * 2 ** attemptRef.current, 15000);
        attemptRef.current += 1;
        retryTimerRef.current = setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => socket.close());
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [setRoundTripMs, setStatus]);

  const sendPing = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const message: PingMessage = { type: "ping", ts: Date.now() };
    pendingPingRef.current = message.ts;
    setRoundTripMs(null);
    socket.send(JSON.stringify(message));
  }, [setRoundTripMs]);

  return { sendPing };
}
