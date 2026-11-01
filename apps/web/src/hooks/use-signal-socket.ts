"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  parseServerMessage,
  type ClientSignalMessage,
  type ServerSignalMessage,
} from "@zerocloud/shared";
import { useSignalStore } from "../lib/signal-store";
import { publicConfig } from "../lib/config";

const signalUrl = publicConfig.NEXT_PUBLIC_SIGNAL_URL;

type SignalSocketHandlers = {
  onMessage: (message: ServerSignalMessage) => void;
  onOpen: () => void;
  onDisconnect: () => void;
  onInvalidMessage: (error: string) => void;
};

export function useSignalSocket(
  handlers: SignalSocketHandlers,
  accessToken: string | null,
): {
  send: (message: ClientSignalMessage) => boolean;
} {
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const handlersRef = useRef(handlers);
  const setStatus = useSignalStore((state) => state.setStatus);
  handlersRef.current = handlers;

  useEffect(() => {
    let stopped = false;
    if (!accessToken) {
      setStatus("disconnected");
      return;
    }

    const scheduleReconnect = (): void => {
      if (stopped || retryTimerRef.current) return;
      setStatus("disconnected");
      handlersRef.current.onDisconnect();
      const delay = Math.min(1000 * 2 ** attemptRef.current, 15000);
      attemptRef.current += 1;
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        connect();
      }, delay);
    };

    const connect = (): void => {
      if (stopped) return;
      setStatus("connecting");
      let socket: WebSocket;
      try {
        socket = new WebSocket(signalUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      let authenticated = false;
      const wakingTimer = setTimeout(() => {
        if (socketRef.current === socket && !authenticated) setStatus("waking");
      }, 3000);

      socket.addEventListener("open", () => {
        attemptRef.current = 0;
        socket.send(JSON.stringify({ type: "auth", token: accessToken }));
      });
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string") {
          handlersRef.current.onInvalidMessage(
            "Expected a text protocol message",
          );
          return;
        }
        const parsed = parseServerMessage(event.data);
        if (!parsed.success) {
          handlersRef.current.onInvalidMessage(parsed.error);
          return;
        }
        if (parsed.data.type === "authenticated") {
          authenticated = true;
          clearTimeout(wakingTimer);
          setStatus("connected");
          handlersRef.current.onOpen();
          return;
        }
        handlersRef.current.onMessage(parsed.data);
      });
      socket.addEventListener("close", () => {
        clearTimeout(wakingTimer);
        if (socketRef.current === socket) socketRef.current = null;
        scheduleReconnect();
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [accessToken, setStatus]);

  const send = useCallback((message: ClientSignalMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  return { send };
}
