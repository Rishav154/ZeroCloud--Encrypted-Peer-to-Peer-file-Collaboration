import { z } from "zod";
import { publicConfig } from "../config";

const iceServerSchema = z.object({
  urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
}).strict();

const responseSchema = z.object({
  iceServers: z.array(iceServerSchema).min(1),
  ttlSeconds: z.number().int().min(1),
}).strict();

export type IceServerBundle = {
  iceServers: RTCIceServer[];
  expiresAt: number;
};

export class IceServerCache {
  private cached: IceServerBundle | null = null;
  private request: Promise<IceServerBundle> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(bundle: IceServerBundle) => void>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(accessToken: string): Promise<IceServerBundle> {
    if (this.cached && this.cached.expiresAt - this.now() > 30_000) return this.cached;
    return this.refresh(accessToken);
  }

  private async refresh(accessToken: string): Promise<IceServerBundle> {
    if (this.request) return this.request;
    this.request = this.fetchBundle(accessToken);
    try {
      this.cached = await this.request;
      this.scheduleRefresh(accessToken);
      return this.cached;
    } finally {
      this.request = null;
    }
  }

  subscribe(listener: (bundle: IceServerBundle) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cached = null;
    this.request = null;
  }

  private async fetchBundle(accessToken: string): Promise<IceServerBundle> {
    const response = await this.fetcher(`${publicConfig.NEXT_PUBLIC_API_URL}/ice-servers`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Could not fetch ICE server credentials");
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Signal server returned invalid ICE configuration");
    const iceServers: RTCIceServer[] = parsed.data.iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    }));
    return { iceServers, expiresAt: this.now() + parsed.data.ttlSeconds * 1000 };
  }

  private scheduleRefresh(accessToken: string): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.cached) return;
    const ttlMs = this.cached.expiresAt - this.now();
    const leadMs = Math.min(60_000, Math.max(5000, Math.floor(ttlMs * 0.15)));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh(accessToken)
        .then((bundle) => { for (const listener of this.listeners) listener(bundle); })
        .catch(() => {
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.refresh(accessToken).then((bundle) => {
              for (const listener of this.listeners) listener(bundle);
              this.scheduleRefresh(accessToken);
            }).catch(() => this.scheduleRefresh(accessToken));
          }, 10_000);
        });
    }, Math.max(1000, ttlMs - leadMs));
  }
}

export const iceServerCache = new IceServerCache();
