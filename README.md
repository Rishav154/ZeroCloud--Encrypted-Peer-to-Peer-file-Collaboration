# ZeroCloud

ZeroCloud is a browser-based peer-to-peer collaboration project. File chunks and file metadata are encrypted in the browser before travelling directly over native WebRTC DataChannels. The signalling server forwards WebRTC setup messages only; PostgreSQL stores metadata only. Chat remains plaintext in this phase.

## Requirements

- Node.js 20 or newer
- pnpm 10
- Docker Compose
- A modern browser with WebRTC support

## Local setup

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm dev
```

Open <http://localhost:3000> in two browser tabs. The signalling server runs on port `4000`; its WebSocket endpoint is `ws://localhost:4000/ws`.

The page creates a room ID and peer ID for each tab. Keep the room ID from one tab, enter it in the other tab, and join. Peers exchange identity keys directly over their DataChannel and reach **secure** after opening the sealed ready confirmation. A third tab can join the same room to form a full mesh.

## ICE configuration

`NEXT_PUBLIC_STUN_URLS` accepts a comma-separated list of STUN URLs. It defaults to Google's public STUN endpoint. `NEXT_PUBLIC_TURN_URL` accepts a comma-separated list of TURN URLs; they are placed together in one ICE server entry and share `NEXT_PUBLIC_TURN_USERNAME` and `NEXT_PUBLIC_TURN_CREDENTIAL`. For example, you can list UDP, TCP, and TLS endpoints for the same TURN service. Restart the web dev server after changing these values.

Set `NEXT_PUBLIC_FORCE_RELAY=true` to require relay candidates for a connection when testing TURN.

For crypto testing, set `NEXT_PUBLIC_FORCE_P256=true` to force a P-256 identity (this rotates a saved X25519 identity once). `NEXT_PUBLIC_DEBUG_WIRE=true` adds only ciphertext prefixes and byte counts to the debug panel. `NEXT_PUBLIC_DEBUG_TAMPER=true` flips one bit in the third chunk during `pnpm dev` so the receiver integrity failure can be exercised. Restart the web server after changing these variables. Use separate browser profiles/origins to test peers with different algorithms.

Because `NEXT_PUBLIC_*` values are available in the browser, TURN credentials are visible to users of the built app. Use credentials intended for client distribution, such as short-lived credentials from a TURN provider.

The peer list reports the selected ICE candidate type: `host`, `srflx`, or `relay`. A relay candidate is shown as **relayed**; host and server-reflexive candidates are shown as **direct**. Some mobile or corporate networks require TURN for a connection.

## File transfer

Join the same room from two tabs or devices. In **Transfers**, choose one secure peer or **Send to all**, select files or drop them in the target area, and accept the incoming offer on the receiving device. File names, MIME types, sizes, hashes, and file keys are sealed with the peer session key. File contents use a fresh AES-256-GCM key per transfer and ordered 16 KiB encrypted chunks with DataChannel backpressure, progress, speed, ETA, cancellation, and final SHA-256 verification. Files larger than 500 MB are refused. A verified incoming file appears with a **Download** button. Chat messages remain plaintext.

Run the unit tests with `pnpm test`; run `pnpm typecheck` and `pnpm lint` for project checks. Crypto tests use the Node WebCrypto implementation and cover identity key agreement, fingerprints, sealed envelopes, direction binding, and AES-GCM chunks.

## Cryptographic design

| Primitive                        | Purpose                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| ECDH X25519, with P-256 fallback | Persistent browser identity agreement                                                |
| HKDF-SHA-256                     | Derive a fresh session key from identity ECDH and both per-connection nonces         |
| AES-256-GCM session key          | Seal file metadata and confirm the handshake                                         |
| AES-256-GCM fresh file key       | Encrypt each file chunk; each chunk index supplies a unique IV for that transfer key |
| SHA-256                          | Identity fingerprints and final plaintext file integrity check                       |

Each DataChannel follows this handshake state machine:

1. `new → hello-sent`: send one hello with the identity algorithm, public key, and a fresh 32-byte random nonce encoded as base64. A second hello on the same channel or a nonce that does not decode to exactly 32 bytes fails the handshake.
2. `hello-received → deriving`: independently sort the two raw public keys and the two nonces bytewise. Derive the HKDF salt as SHA-256 of `zerocloud/v1/salt` followed by the length-prefixed sorted keys and length-prefixed sorted nonces. HKDF info is `zerocloud/v1/session`.
3. `deriving → ready-sent`: exchange a sealed ready message. Its AAD binds both sorted nonces and both fingerprints, plus the sender/receiver direction.
4. `ready-received → secure`: only after the ready message authenticates can file transfers begin. Equal fingerprints are supported for tabs sharing one browser identity and are marked **same identity as this device**.

A transfer uses a new random file key and one chunk-transform instance bound to its transfer ID and total chunk count. The session key is non-extractable; the private identity key is non-extractable and stored as a CryptoKey in IndexedDB.

## Known limitations

- Static identity keys provide no forward secrecy across sessions. A future compromise of an identity private key can expose recorded handshakes and session-derived material.
- Clearing site data loses the browser identity and its verified fingerprints.
- Fingerprints must be compared out of band to defend against a malicious signalling server that substitutes peer connections.
- Chat remains plaintext; Phase 4 encrypts file content and file metadata only.

## Health and quality commands

```sh
curl http://localhost:4000/health
pnpm build
pnpm lint
pnpm typecheck
```

`/health` checks the PostgreSQL connection with `SELECT 1`. The database remains metadata-only and has no tables in this phase.
