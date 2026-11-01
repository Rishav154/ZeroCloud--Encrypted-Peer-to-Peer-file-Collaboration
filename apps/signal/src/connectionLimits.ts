export class ConnectionLimits {
  private readonly ipCounts = new Map<string, number>();
  private readonly userCounts = new Map<string, number>();

  constructor(
    readonly maxPerIp = 20,
    readonly maxPerUser = 10,
  ) {}

  acquireIp(ip: string): boolean {
    const count = this.ipCounts.get(ip) ?? 0;
    if (count >= this.maxPerIp) return false;
    this.ipCounts.set(ip, count + 1);
    return true;
  }

  releaseIp(ip: string): void {
    decrement(this.ipCounts, ip);
  }

  acquireUser(userId: string): boolean {
    const count = this.userCounts.get(userId) ?? 0;
    if (count >= this.maxPerUser) return false;
    this.userCounts.set(userId, count + 1);
    return true;
  }

  releaseUser(userId: string): void {
    decrement(this.userCounts, userId);
  }
}

function decrement(counts: Map<string, number>, key: string): void {
  const count = counts.get(key);
  if (count === undefined) return;
  if (count <= 1) counts.delete(key);
  else counts.set(key, count - 1);
}
