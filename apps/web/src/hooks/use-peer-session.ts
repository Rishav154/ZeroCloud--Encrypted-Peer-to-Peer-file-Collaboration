"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_FILE_SIZE,
  type ClientSignalMessage,
  type ServerSignalMessage,
} from "@zerocloud/shared";
import { usePeerStore } from "../lib/peer-store";
import { PeerManager } from "../lib/webrtc/PeerManager";
import {
  getOrCreateIdentity,
  loadVerifiedFingerprints,
  resetIdentity as deleteIdentity,
  saveVerifiedFingerprint,
  type StoredIdentity,
} from "../lib/identity/identityStore";
import { useSignalSocket } from "./use-signal-socket";
import { useAuthStore } from "../lib/auth/session";

type ActiveSession = { workspaceId: string; peerId: string };
type IdentityView = {
  algorithm: StoredIdentity["algorithm"];
  fingerprint: string;
};

function recordEvent(
  event: string,
  level: "info" | "error" = "info",
  peerId?: string,
): void {
  usePeerStore.getState().addEvent({
    at: Date.now(),
    level,
    event,
    ...(peerId ? { peerId } : {}),
  });
}

export function usePeerSession(
  workspaceId: string,
  localRole: "owner" | "editor" | "viewer",
): {
  peerId: string | null;
  identity: IdentityView | null;
  identityError: string | null;
  activeWorkspaceId: string | null;
  isJoined: boolean;
  openPeerCount: number;
  joinWorkspace: () => void;
  leaveWorkspace: () => void;
  sendChat: (text: string) => boolean;
  sendFile: (file: File, peerId: string | "all") => number;
  acceptTransfer: (peerId: string, transferId: number) => void;
  declineTransfer: (peerId: string, transferId: number) => void;
  cancelTransfer: (
    peerId: string,
    transferId: number,
    direction: "incoming" | "outgoing",
  ) => void;
  resetIdentity: () => Promise<void>;
  verifyPeer: (peerId: string) => Promise<void>;
} {
  const peerId = usePeerStore((state) => state.peerId);
  const activeWorkspaceId = usePeerStore((state) => state.activeWorkspaceId);
  const isJoined = usePeerStore((state) => state.isJoined);
  const openPeerCount = usePeerStore(
    (state) =>
      Object.values(state.peers).filter(
        (peer) => peer.dataChannelState === "open",
      ).length,
  );
  const managerRef = useRef<PeerManager | null>(null);
  const activeSessionRef = useRef<ActiveSession | null>(null);
  const sendRef = useRef<(message: ClientSignalMessage) => boolean>(
    () => false,
  );
  const managerUnsubscribeRef = useRef<Array<() => void>>([]);
  const identityRef = useRef<StoredIdentity | null>(null);
  const verifiedFingerprintsRef = useRef<Set<string>>(new Set());
  const identityPromiseRef = useRef<Promise<void> | null>(null);
  const [identity, setIdentity] = useState<IdentityView | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const setPeerId = usePeerStore((state) => state.setPeerId);
  const accessToken = useAuthStore((state) => state.accessToken);

  useEffect(() => {
    if (!peerId) setPeerId(crypto.randomUUID());
  }, [peerId, setPeerId]);

  useEffect(() => {
    let current = true;
    if (!identityPromiseRef.current) {
      identityPromiseRef.current = Promise.all([
        getOrCreateIdentity(process.env.NEXT_PUBLIC_FORCE_P256 === "true"),
        loadVerifiedFingerprints(),
      ]).then(([storedIdentity, verified]) => {
        identityRef.current = storedIdentity;
        verifiedFingerprintsRef.current = verified;
      });
    }
    void identityPromiseRef.current
      .then(() => {
        if (!current || !identityRef.current) return;
        setIdentity({
          algorithm: identityRef.current.algorithm,
          fingerprint: identityRef.current.fingerprint,
        });
        setIdentityError(null);
      })
      .catch((error: unknown) => {
        if (!current) return;
        const message =
          error instanceof Error
            ? error.message
            : "Could not load browser identity";
        setIdentityError(message);
        usePeerStore.getState().setError(message);
      });
    return () => {
      current = false;
    };
  }, []);

  const teardownManager = useCallback((): void => {
    for (const unsubscribe of managerUnsubscribeRef.current.splice(0)) {
      unsubscribe();
    }
    managerRef.current?.destroy();
    managerRef.current = null;
  }, []);

  const handleServerMessage = useCallback(
    (message: ServerSignalMessage): void => {
      const manager = managerRef.current;
      const store = usePeerStore.getState();

      if (message.type === "joined") {
        const active = activeSessionRef.current;
        if (!active || active.peerId !== message.peerId) return;
        store.setJoined(true);
        store.setError(null);
        for (const peer of message.peers)
          store.setMember({
            userId: peer.userId,
            displayName: peer.displayName,
            role: peer.role,
            fingerprint: peer.fingerprint,
            publicKey: "",
          });
        recordEvent(`joined-workspace:${active.workspaceId}`);
        for (const peer of message.peers) {
          manager?.addPeer(peer);
          void manager?.connectToPeer(peer.peerId);
        }
        return;
      }

      if (message.type === "peer-joined") {
        manager?.addPeer(message.peer);
        store.setMember({
          userId: message.peer.userId,
          displayName: message.peer.displayName,
          role: message.peer.role,
          fingerprint: message.peer.fingerprint,
          publicKey: "",
        });
        recordEvent("peer-joined", "info", message.peer.peerId);
        return;
      }

      if (message.type === "peer-left") {
        manager?.removePeer(message.peerId);
        store.removePeer(message.peerId);
        recordEvent("peer-left", "info", message.peerId);
        return;
      }

      if (message.type === "member-added") {
        store.setMember(message.member);
        recordEvent("member-added");
        return;
      }
      if (message.type === "member-removed") {
        store.removeMember(message.userId);
        recordEvent("member-removed");
        return;
      }
      if (message.type === "role-changed") {
        store.setMemberRole(message.userId, message.role);
        manager?.updateUserRole(message.userId, message.role);
        recordEvent(`role-changed:${message.role}`);
        return;
      }
      if (message.type === "kicked") {
        activeSessionRef.current = null;
        teardownManager();
        store.resetSession();
        store.setError(message.message);
        recordEvent("kicked-from-workspace", "error");
        return;
      }

      if (message.type === "signal") {
        void manager?.handleSignal(message.from, message.data);
        recordEvent(`signal-${message.data.kind}`, "info", message.from);
        return;
      }

      if (message.type === "error") {
        store.setError(`${message.code}: ${message.message}`);
        recordEvent(`server-error:${message.code}`, "error");
      }
    },
    [],
  );

  const handleOpen = useCallback((): void => {
    const active = activeSessionRef.current;
    if (!active) return;
    const sent = sendRef.current({
      type: "join",
      workspaceId: active.workspaceId,
      peerId: active.peerId,
    });
    if (sent) recordEvent("workspace-rejoin-sent");
  }, []);

  const handleDisconnect = useCallback((): void => {
    managerRef.current?.closeAll();
    const store = usePeerStore.getState();
    store.clearPeers();
    store.setJoined(false);
    recordEvent("signalling-disconnected", "error");
  }, []);

  const handleInvalidMessage = useCallback((error: string): void => {
    usePeerStore.getState().setError(error);
    recordEvent("invalid-server-message", "error");
  }, []);

  const signal = useSignalSocket(
    {
      onMessage: handleServerMessage,
      onOpen: handleOpen,
      onDisconnect: handleDisconnect,
      onInvalidMessage: handleInvalidMessage,
    },
    accessToken,
  );
  sendRef.current = signal.send;

  const joinWorkspace = useCallback((): void => {
    if (!peerId) {
      usePeerStore.getState().setError("Peer ID is still being created");
      return;
    }
    if (!identityRef.current) {
      usePeerStore
        .getState()
        .setError("Browser identity is still being prepared");
      return;
    }
    if (activeSessionRef.current) {
      usePeerStore
        .getState()
        .setError("Leave the current room before joining another");
      return;
    }

    const active = { workspaceId, peerId };
    const store = usePeerStore.getState();
    store.resetSession();
    store.setActiveWorkspace(active.workspaceId);
    store.setError(null);
    activeSessionRef.current = active;

    const manager = new PeerManager(
      peerId,
      (to, data) => {
        if (!sendRef.current({ type: "signal", to, data })) {
          recordEvent("signal-send-failed", "error", to);
        }
      },
      identityRef.current,
      verifiedFingerprintsRef.current,
    );
    managerRef.current = manager;
    managerUnsubscribeRef.current = [
      manager.events.on("state", (state) => {
        usePeerStore.getState().setPeer(state);
      }),
      manager.events.on("removed", ({ peerId: removedPeerId }) => {
        usePeerStore.getState().removePeer(removedPeerId);
      }),
      manager.events.on("message", ({ peerId: fromPeerId, message }) => {
        usePeerStore.getState().addMessage({
          id: crypto.randomUUID(),
          peerId: fromPeerId,
          message,
          direction: "received",
        });
      }),
      manager.events.on("log", (event) => {
        usePeerStore.getState().addEvent(event);
      }),
      manager.events.on("transfer", (transfer) => {
        usePeerStore.getState().setTransfer(transfer);
        if (transfer.direction === "incoming" && transfer.state !== "waiting") {
          usePeerStore
            .getState()
            .removeIncomingOffer(transfer.peerId, transfer.transferId);
        }
        usePeerStore.getState().addEvent({
          at: Date.now(),
          level: transfer.state === "failed" ? "error" : "info",
          event: `transfer-${transfer.state}`,
          peerId: transfer.peerId,
        });
      }),
      manager.events.on("incomingOffer", (offer) => {
        usePeerStore.getState().addIncomingOffer(offer);
        usePeerStore.getState().addEvent({
          at: Date.now(),
          level: "info",
          event: "file-offer-received",
          peerId: offer.peerId,
        });
      }),
    ];

    if (
      !sendRef.current({
        type: "join",
        workspaceId: active.workspaceId,
        peerId,
      })
    ) {
      recordEvent("workspace-join-queued-until-connected");
    } else {
      recordEvent(`workspace-join-sent:${active.workspaceId}`);
    }
  }, [peerId, workspaceId]);

  const leaveWorkspace = useCallback((): void => {
    if (activeSessionRef.current) {
      sendRef.current({ type: "leave" });
      recordEvent("workspace-leave-sent");
    }
    activeSessionRef.current = null;
    teardownManager();
    usePeerStore.getState().resetSession();
  }, [teardownManager]);

  const sendChat = useCallback((rawText: string): boolean => {
    const text = rawText.trim();
    const manager = managerRef.current;
    const store = usePeerStore.getState();
    if (!text || !store.isJoined || !manager || manager.openPeerCount === 0) {
      return false;
    }

    const { message, sent } = manager.broadcastText(text);
    if (sent === 0) return false;
    store.addMessage({
      id: crypto.randomUUID(),
      peerId: store.peerId ?? "",
      message,
      direction: "sent",
    });
    return true;
  }, []);

  const sendFile = useCallback(
    (file: File, targetPeerId: string | "all"): number => {
      const manager = managerRef.current;
      if (!usePeerStore.getState().isJoined || !manager) {
        usePeerStore
          .getState()
          .setError("Join the workspace before sending files");
        return 0;
      }
      if (localRole === "viewer") {
        usePeerStore.getState().setError("Viewers cannot send files");
        return 0;
      }
      if (file.size > MAX_FILE_SIZE) {
        usePeerStore.getState().setError("Maximum file size is 500 MB");
        return 0;
      }
      const results =
        targetPeerId === "all"
          ? manager.sendFileToAll(file)
          : [
              {
                peerId: targetPeerId,
                transferId: manager.sendFile(targetPeerId, file),
              },
            ].filter(
              (entry): entry is { peerId: string; transferId: number } =>
                entry.transferId !== null,
            );
      if (results.length === 0) {
        usePeerStore
          .getState()
          .setError(
            "No secure peer is available yet. Wait for the handshake to finish.",
          );
        return 0;
      }
      usePeerStore.getState().setError(null);
      return results[0]?.transferId ?? 0;
    },
    [localRole],
  );

  const acceptTransfer = useCallback(
    (remotePeerId: string, transferId: number): void => {
      managerRef.current?.acceptTransfer(remotePeerId, transferId);
      usePeerStore.getState().removeIncomingOffer(remotePeerId, transferId);
    },
    [],
  );
  const declineTransfer = useCallback(
    (remotePeerId: string, transferId: number): void => {
      managerRef.current?.declineTransfer(remotePeerId, transferId);
      usePeerStore.getState().removeIncomingOffer(remotePeerId, transferId);
    },
    [],
  );
  const cancelTransfer = useCallback(
    (
      remotePeerId: string,
      transferId: number,
      direction: "incoming" | "outgoing",
    ): void => {
      managerRef.current?.cancelTransfer(remotePeerId, transferId, direction);
    },
    [],
  );

  const resetIdentity = useCallback(async (): Promise<void> => {
    if (activeSessionRef.current) sendRef.current({ type: "leave" });
    activeSessionRef.current = null;
    teardownManager();
    usePeerStore.getState().resetSession();
    identityRef.current = null;
    verifiedFingerprintsRef.current = new Set();
    setIdentity(null);
    setIdentityError(null);
    identityPromiseRef.current = null;
    try {
      await deleteIdentity();
      const storedIdentity = await getOrCreateIdentity(
        process.env.NEXT_PUBLIC_FORCE_P256 === "true",
      );
      const verified = await loadVerifiedFingerprints();
      identityRef.current = storedIdentity;
      verifiedFingerprintsRef.current = verified;
      setIdentity({
        algorithm: storedIdentity.algorithm,
        fingerprint: storedIdentity.fingerprint,
      });
      recordEvent("identity-reset");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not reset browser identity";
      setIdentityError(message);
      usePeerStore.getState().setError(message);
    }
  }, [teardownManager]);

  const verifyPeer = useCallback(
    async (remotePeerId: string): Promise<void> => {
      const peer = usePeerStore.getState().peers[remotePeerId];
      if (!peer?.fingerprint || peer.handshakeState !== "secure") return;
      try {
        await saveVerifiedFingerprint(peer.fingerprint);
        verifiedFingerprintsRef.current.add(peer.fingerprint);
        managerRef.current?.setFingerprintVerified(peer.fingerprint);
        recordEvent("peer-fingerprint-verified", "info", remotePeerId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not save verified fingerprint";
        usePeerStore.getState().setError(message);
      }
    },
    [],
  );

  useEffect(() => {
    const onPageHide = (): void => {
      if (activeSessionRef.current) sendRef.current({ type: "leave" });
      activeSessionRef.current = null;
      teardownManager();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      activeSessionRef.current = null;
      teardownManager();
    };
  }, [teardownManager]);

  return {
    peerId,
    identity,
    identityError,
    activeWorkspaceId,
    isJoined,
    openPeerCount,
    joinWorkspace,
    leaveWorkspace,
    sendChat,
    sendFile,
    acceptTransfer,
    declineTransfer,
    cancelTransfer,
    resetIdentity,
    verifyPeer,
  };
}
