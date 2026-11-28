const KEY = "zerocloud-nearby-alias-v1";
const adjectives = ["Amber", "Brisk", "Calm", "Deep", "Eager", "Fair", "Gentle", "Happy", "Ivory", "Jolly", "Keen", "Lucid", "Mellow", "Nimble", "Open", "Proud"];
const nouns = ["Acorn", "Birch", "Cloud", "Dawn", "Ember", "Fern", "Grove", "Harbor", "Island", "Juniper", "Kite", "Lantern", "Meadow", "Oak", "River", "Willow"];
export function createAlias(): string { const random = new Uint32Array(2); crypto.getRandomValues(random); return `${adjectives[(random[0] ?? 0) % adjectives.length]} ${nouns[(random[1] ?? 0) % nouns.length]}`; }
export function loadAlias(): string { try { const existing = localStorage.getItem(KEY); if (existing) return existing; const alias = createAlias(); localStorage.setItem(KEY, alias); return alias; } catch { return createAlias(); } }
export function saveAlias(value: string): void { try { localStorage.setItem(KEY, value.trim().slice(0, 24)); } catch { /* Nearby remains usable without persistent local storage. */ } }
