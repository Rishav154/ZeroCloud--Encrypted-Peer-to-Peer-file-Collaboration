# ZeroCloud

ZeroCloud is a browser-based peer-to-peer collaboration project. Files and file metadata are encrypted in the browser before travelling directly over WebRTC DataChannels. PostgreSQL stores accounts and workspace metadata, including sealed workspace names and wrapped workspace keys; it never receives plaintext files, workspace names, workspace keys, invite secrets, or private identity keys.

## Requirements

- Node.js 20 or newer
- pnpm 10
- Docker Compose
- A modern browser with WebCrypto and WebRTC support

## Local setup

On a first setup, copy the example environment file and replace the local JWT secret with a fresh random value of at least 32 characters. If you already have a `.env`, merge the new entries instead of overwriting it.

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm dev
```

Open <http://localhost:3000/register> to create an account. Account registration is tied to the identity key in that browser's IndexedDB. Sign in from that same browser profile, then create and open workspaces at <http://localhost:3000/workspaces>. The API and signalling server run on port `4000`.

The required environment values are `DATABASE_URL`, `ALLOWED_ORIGIN`, `WEB_ORIGIN`, and `JWT_SECRET`. `JWT_SECRET` must be at least 32 characters. Set `NEXT_PUBLIC_WEB_ORIGIN` to the browser-visible equivalent of `WEB_ORIGIN` for invite URLs. The browser uses `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:4000/api`). `TEST_DATABASE_URL` must point to the separate `zerocloud_test` database.

The Postgres initialization script creates `zerocloud_test` when a new named volume is initialized. Existing volumes do not rerun initialization scripts; if needed, create the test DB once with:

```sh
docker compose exec postgres sh -c 'createdb -U "$POSTGRES_USER" zerocloud_test'
```

## Accounts and identity binding

Registration sends the account email, display name, password, identity public key, algorithm, and SHA-256 fingerprint. The server hashes passwords with Argon2id and independently recomputes the fingerprint. The private identity key remains in IndexedDB and is never sent to the server. A fingerprint can register only one account. The server does not prove private-key possession during registration; peers confirm key agreement through the Phase 4 handshake.

Login returns the registered fingerprint. The browser compares it to its local identity before saving the session. A mismatch blocks login with **This account is bound to a different device identity**. There is no identity rebinding, backup, password reset, or account recovery in this phase. Clearing site data or resetting the identity permanently loses access to that account's workspaces.

Sessions are HS256 JWTs with a 12-hour expiry. The browser keeps the token in memory and `sessionStorage` so a page reload preserves the session until the tab is closed or the token expires. JavaScript running through an XSS vulnerability can read a `sessionStorage` token; this is a deliberate trade-off for this phase. The server never logs passwords or tokens.

## Workspaces and key flow

Workspace IDs are generated in the browser. The browser creates a random AES-256-GCM workspace key, seals the workspace name, and wraps the raw workspace key for the creator's identity. The API receives only `name_sealed` and `wrapped_key`; the wrapped key is stored in `workspace_keys` for the owner's current key version. Workspace keys are unwrapped into memory when a workspace is opened and are not persisted in IndexedDB.

Workspace details and member directory data are returned only to members; a non-member receives 404. On creation, the client encrypts the workspace name, creates the random workspace key and self-wraps it for the owner before the API stores those ciphertexts. On invite, the owner creates a fresh 32-byte secret and invite UUID, derives an invite key with HKDF, and seals the workspace key. The link is `/join/<inviteId>#<base64url-secret>`; its secret fragment is removed from the address bar after the invite page reads it. The invitee decrypts the workspace key in their browser, wraps it for their own identity, and posts only that wrapped key. The server locks the invite row and atomically adds the member, stores their wrapped key, and marks the invite used. The secret and plaintext key never reach the server. Owners can create editor/viewer invites with 1-hour, 24-hour, or 7-day expiry, list pending invites, and revoke them.

Run migrations with `pnpm db:migrate`. Numbered SQL files under `apps/signal/migrations` are applied once and recorded in `schema_migrations`; the runner uses parameterized queries for all dynamic values.

## REST API

| Method   | Path                                    | Purpose                                                                          |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `POST`   | `/api/auth/register`                    | Create an account bound to the submitted browser identity                        |
| `POST`   | `/api/auth/login`                       | Verify credentials and return a 12-hour session token and registered fingerprint |
| `GET`    | `/api/me`                               | Return the authenticated account and identity                                    |
| `POST`   | `/api/workspaces`                       | Create a workspace, owner membership, and self-wrapped key in one transaction    |
| `GET`    | `/api/workspaces`                       | List the caller's workspaces with role and sealed names                          |
| `GET`    | `/api/workspaces/:id`                   | Return a member's wrapped key, current version, and member directory             |
| `POST`   | `/api/workspaces/:id/invites`           | Create a sealed single-use editor/viewer invite (owner only)                     |
| `GET`    | `/api/workspaces/:id/invites`           | List pending invites (owner only)                                                |
| `DELETE` | `/api/workspaces/:id/invites/:inviteId` | Revoke a pending invite (owner only)                                             |
| `GET`    | `/api/invites/:inviteId`                | Return authenticated invite metadata and sealed workspace key                    |
| `POST`   | `/api/invites/:inviteId/accept`         | Atomically accept invite and store the caller's wrapped key                      |
| `PATCH`  | `/api/workspaces/:id/members/:userId`   | Change a member to editor or viewer (owner only)                                 |
| `DELETE` | `/api/workspaces/:id/members/:userId`   | Remove a member and delete wrapped keys (owner only)                             |

Request bodies and path parameters are validated with Zod. Responses use `{ "error": { "code": "...", "message": "..." } }`. Authentication endpoints are rate limited to 10 requests per minute per IP. Helmet sets HTTP security headers, and CORS is restricted to `ALLOWED_ORIGIN`.

## Cryptographic design

| Primitive                         | Purpose                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| ECDH X25519, with P-256 fallback  | Persistent browser identity agreement                                                     |
| HKDF-SHA-256                      | Derive per-connection session keys from identity ECDH and both fresh nonces               |
| AES-256-GCM session key           | Seal file metadata and confirm the handshake                                              |
| AES-256-GCM fresh file key        | Encrypt each file chunk; chunk index and transfer context supply unique IV/AAD values     |
| SHA-256                           | Identity fingerprints and final plaintext file integrity check                            |
| ECDH + HKDF-SHA-256               | Derive a key-wrapping key from the wrapper and recipient identity keys                    |
| AES-256-GCM wrapped workspace key | Seal the 256-bit workspace key with workspace ID, version, and both fingerprints in AAD   |
| AES-256-GCM workspace key         | Seal the workspace name with `zerocloud/v1/ws-name` and workspace ID as AAD               |
| HKDF-SHA-256 invite key           | Derive an invite-scoped sealing key from the URL-fragment secret and invite ID            |
| AES-256-GCM invite envelope       | Seal the workspace key for invite redemption, bound to workspace, invite, and key version |

Each DataChannel exchanges one hello containing an algorithm, public key, and fresh 32-byte random nonce. Both peers independently sort raw public keys and nonces bytewise, derive a symmetric HKDF salt, and exchange a direction-bound sealed ready message. Tabs sharing one browser profile can have the same identity and are marked **same identity as this device**.

Handshake state flow: workspace-authenticated → joined with peer directory → WebRTC offer/answer and ICE → DataChannel hello with nonce → compare hello fingerprint against the directory → derive the Phase 4 session key → exchange nonce/fingerprint-bound sealed `ready` messages → secure. A directory mismatch is marked identity mismatch and blocks chat/file handling for that peer. Failure to validate or confirm the handshake never reaches the secure state.

Workspace wrapping derives ECDH bits from the wrapper's private key and recipient's public key. Sorted, length-prefixed public keys feed the SHA-256 HKDF salt; the HKDF info is `zerocloud/v1/wrap`. The wrap envelope AAD binds the workspace ID, uint32 key version, wrapper fingerprint, and recipient fingerprint. Self-wrap is supported. Name sealing uses AAD formed from `zerocloud/v1/ws-name` followed by the workspace ID.

## Roles and authenticated signaling

Roles are `owner` (workspace creator), `editor` (send and receive), and `viewer` (receive only). Only owners can invite, change roles, or remove members. An authenticated WebSocket must send its JWT within five seconds and can join only a workspace where its user is a member. The workspace peer directory supplies identity fingerprints and roles; the joining peer creates offers to peers already listed, while existing peers answer. Hello fingerprints must match the directory before the Phase 4 encrypted ready handshake can mark a peer secure. Same-profile tabs may share an identity and are labelled accordingly. Members, roles, presence, kicks, and peer departures update over the workspace room in real time.

The sender UI disables file sending for viewers. Receivers automatically reject offers from a viewer or a peer with unknown role using `no write permission`. This is cooperative protection among honest clients; a modified client can bypass its own UI checks. The directory comes from the server, so out-of-band fingerprint verification remains important against a malicious server. The server sees the social graph: who belongs to which workspace and when members are online.

Removing a member will not rotate the workspace key in this phase. **Removed members still hold the old workspace key until key rotation is implemented.**

## Workspace peer and file-transfer testing

Open a workspace in two authenticated browser profiles, create an invite from the owner profile, and open the link in the second profile. The invite secret appears only after `#`, and the page strips it from the address bar after reading it. Join the workspace from each tab and test chat and direct file transfer. The invitation is single use and expires on its selected schedule; pending invites may be revoked. Configure STUN/TURN with `NEXT_PUBLIC_STUN_URLS`, `NEXT_PUBLIC_TURN_URL`, `NEXT_PUBLIC_TURN_USERNAME`, and `NEXT_PUBLIC_TURN_CREDENTIAL`. Comma-separated TURN URLs share one username and credential. These browser-visible credentials should be intended for client use, such as short-lived TURN credentials.

`NEXT_PUBLIC_FORCE_P256=true` forces a P-256 identity. `NEXT_PUBLIC_DEBUG_WIRE=true` adds ciphertext prefixes and byte counts to the debug panel. `NEXT_PUBLIC_DEBUG_TAMPER=true` flips a bit in the third file chunk during development to exercise integrity failure.

## Tests and known limitations

Run `pnpm test`, `pnpm typecheck`, and `pnpm lint`. API tests use `TEST_DATABASE_URL` and truncate tables between tests; never point it at a development or production database. Workspace crypto tests use Node WebCrypto and cover X25519/P-256 wrapping, self-wrap, wrong recipients, AAD tampering, sealed names, and invite-key sealing with correct and incorrect secrets.

- No key recovery, key backup, password reset, email verification, multi-device identity, or key rotation.
- Registration binds the submitted public key but does not prove private-key possession.
- JWTs in `sessionStorage` are exposed to JavaScript executing through XSS.
- Data-plane role enforcement is cooperative among honest clients.
- The server sees the social graph: account/workspace membership and when peers are online.
- Chat remains plaintext; Phase 4 encrypts file content and file metadata.

## Health and quality commands

```sh
curl http://localhost:4000/health
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```
