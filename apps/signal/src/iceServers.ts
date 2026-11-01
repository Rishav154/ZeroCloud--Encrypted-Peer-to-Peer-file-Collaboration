import { z } from "zod";

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type IceConfig = {
  ICE_MODE: "provider" | "static";
  STUN_URLS: string;
  TURN_APP_NAME?: string | undefined;
  TURN_PROVIDER_SECRET?: string | undefined;
  TURN_CREDENTIAL_TTL_SECONDS: number;
  ICE_STATIC_URLS?: string | undefined;
  ICE_STATIC_USERNAME?: string | undefined;
  ICE_STATIC_CREDENTIAL?: string | undefined;
};

const createdCredentialSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  expiryInSeconds: z.number().int().positive(),
  apiKey: z.string().min(1),
});

const providerServerSchema = z.array(z.object({
  urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
}));

type CredentialCache = {
  iceServers: IceServer[];
  expiresAt: number;
};

export class IceServerService {
  private cached: CredentialCache | null = null;
  private refreshing: Promise<CredentialCache> | null = null;

  constructor(
    private readonly config: IceConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<{ iceServers: IceServer[]; ttlSeconds: number }> {
    if (this.config.ICE_MODE === "static") return this.getStatic();
    if (this.cached && this.cached.expiresAt - this.now() > 120_000) {
      this.refreshInBackground();
      return this.publicValue(this.cached);
    }
    const value = await this.refreshProviderCredential();
    this.cached = value;
    return this.publicValue(value);
  }

  private getStatic(): { iceServers: IceServer[]; ttlSeconds: number } {
    const urls = splitUrls(this.config.ICE_STATIC_URLS ?? "");
    const username = this.config.ICE_STATIC_USERNAME;
    const credential = this.config.ICE_STATIC_CREDENTIAL;
    if (!urls.length || !username || !credential) {
      return {
        iceServers: splitUrls(this.config.STUN_URLS).map((url) => ({ urls: url })),
        ttlSeconds: this.config.TURN_CREDENTIAL_TTL_SECONDS,
      };
    }
    return {
      iceServers: [
        ...splitUrls(this.config.STUN_URLS).map((url) => ({ urls: url })),
        { urls, username, credential },
      ],
      ttlSeconds: this.config.TURN_CREDENTIAL_TTL_SECONDS,
    };
  }

  private refreshInBackground(): void {
    if (this.refreshing) return;
    const cached = this.cached;
    if (!cached || cached.expiresAt - this.now() > 600_000) return;
    const request = this.refreshProviderCredential();
    void request.then(
      (value) => { this.cached = value; },
      () => undefined,
    ).finally(() => {
      if (this.refreshing === request) this.refreshing = null;
    });
  }

  private refreshProviderCredential(): Promise<CredentialCache> {
    if (this.refreshing) return this.refreshing;
    const request = this.createProviderCredential();
    this.refreshing = request;
    void request.then(
      () => { if (this.refreshing === request) this.refreshing = null; },
      () => { if (this.refreshing === request) this.refreshing = null; },
    );
    return request;
  }

  private async createProviderCredential(): Promise<CredentialCache> {
    const appName = this.config.TURN_APP_NAME;
    const secret = this.config.TURN_PROVIDER_SECRET;
    if (!appName || !secret) throw new Error("TURN provider configuration is incomplete");
    const root = `https://${appName}.metered.live/api/v1/turn`;
    const createUrl = new URL(`${root}/credential`);
    createUrl.searchParams.set("secretKey", secret);
    const createdResponse = await this.fetcher(createUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiryInSeconds: this.config.TURN_CREDENTIAL_TTL_SECONDS }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!createdResponse.ok) throw new Error("TURN provider could not issue credentials");
    const created = createdCredentialSchema.safeParse(await createdResponse.json());
    if (!created.success) throw new Error("TURN provider returned an invalid credential response");

    const getUrl = new URL(`${root}/credentials`);
    getUrl.searchParams.set("apiKey", created.data.apiKey);
    const serversResponse = await this.fetcher(getUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!serversResponse.ok) throw new Error("TURN provider did not return ICE server URLs");
    const servers = providerServerSchema.safeParse(await serversResponse.json());
    if (!servers.success) throw new Error("TURN provider returned invalid ICE server data");

    const providerTurn = servers.data
      .filter((server) => toUrls(server.urls).some((url) => url.startsWith("turn:" ) || url.startsWith("turns:")))
      .map((server) => ({ ...server, username: created.data.username, credential: created.data.password }));
    if (!providerTurn.length) throw new Error("TURN provider returned no TURN URLs");
    const iceServers: IceServer[] = [
      ...splitUrls(this.config.STUN_URLS).map((urls) => ({ urls })),
      ...providerTurn,
    ];
    return {
      iceServers,
      expiresAt: this.now() + Math.min(created.data.expiryInSeconds, this.config.TURN_CREDENTIAL_TTL_SECONDS) * 1000,
    };
  }

  private publicValue(cache: CredentialCache): { iceServers: IceServer[]; ttlSeconds: number } {
    return {
      iceServers: cache.iceServers,
      ttlSeconds: Math.max(1, Math.floor((cache.expiresAt - this.now()) / 1000)),
    };
  }
}

function splitUrls(raw: string): string[] {
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function toUrls(urls: string | string[]): string[] {
  return typeof urls === "string" ? [urls] : urls;
}
