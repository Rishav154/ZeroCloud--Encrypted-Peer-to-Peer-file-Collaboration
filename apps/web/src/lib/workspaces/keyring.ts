import {
  deriveWorkspaceNameKey,
  deriveWorkspaceSyncKey,
} from "@zerocloud/shared";

export type WorkspaceKeySet = {
  workspaceKey: CryptoKey;
  syncKey: CryptoKey;
  nameKey: CryptoKey;
};

class WorkspaceKeyring {
  private readonly workspaces = new Map<string, Map<number, WorkspaceKeySet>>();

  async add(workspaceId: string, version: number, workspaceKey: CryptoKey): Promise<void> {
    const keySet: WorkspaceKeySet = {
      workspaceKey,
      syncKey: await deriveWorkspaceSyncKey(workspaceKey, workspaceId, version),
      nameKey: await deriveWorkspaceNameKey(workspaceKey, workspaceId, version),
    };
    const versions = this.workspaces.get(workspaceId) ?? new Map<number, WorkspaceKeySet>();
    versions.set(version, keySet);
    this.workspaces.set(workspaceId, versions);
  }

  get(workspaceId: string, version: number): WorkspaceKeySet | undefined {
    return this.workspaces.get(workspaceId)?.get(version);
  }

  current(workspaceId: string): WorkspaceKeySet | undefined {
    const versions = this.workspaces.get(workspaceId);
    if (!versions) return undefined;
    const currentVersion = Math.max(...versions.keys());
    return versions.get(currentVersion);
  }

  currentVersion(workspaceId: string): number | undefined {
    const versions = this.workspaces.get(workspaceId);
    return versions ? Math.max(...versions.keys()) : undefined;
  }

  clearWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
  }

  clearAll(): void {
    this.workspaces.clear();
  }
}

export const workspaceKeyring = new WorkspaceKeyring();
