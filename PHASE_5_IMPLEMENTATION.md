# ZeroCloud Phase 5 Implementation Report

## Phase aim

Phase 5 replaces unauthenticated, free-form signalling rooms with account-owned workspaces. It binds each account to one browser identity, lets the workspace owner invite other identities without exposing the workspace key to the server, and restricts signalling and workspace administration to current members.

The data-plane design remains peer-to-peer: encrypted file content travels directly over WebRTC DataChannels. The signalling server coordinates connections and relays WebRTC offer, answer, and ICE messages; PostgreSQL stores account and workspace metadata, sealed names, wrapped keys, and invite state. The server does not receive private identity keys, plaintext workspace keys, invite secrets, file names, or file content.

This phase was implemented in two checkpoints. Checkpoint A added account, identity, workspace, and key-wrapping foundations. Checkpoint B added invitations, roles, authenticated workspace signalling, live membership updates, and role enforcement in the existing peer/file-transfer experience.

## Features implemented

### Accounts and identity binding

- Registration accepts an email, password, display name, public identity key, key algorithm, and fingerprint. Email is normalized, passwords are hashed with Argon2id, and the API recomputes the SHA-256 fingerprint from the submitted public key.
- A unique fingerprint prevents one browser identity from registering multiple accounts. Login returns the account fingerprint; the browser blocks login if it differs from its local IndexedDB identity.
- Sessions are HS256 JWTs with a 12-hour expiry. They are held in memory and `sessionStorage` so reloads in the same tab preserve the session.
- Authentication routes are rate limited, request bodies and path parameters are validated with Zod, API responses use a consistent error envelope, and HTTP security headers are provided by Helmet.

### Workspace creation and encrypted metadata

- A workspace ID is generated in the browser. The browser generates a random AES-256-GCM workspace key, seals the workspace name, and wraps the workspace key for the owner identity before sending metadata to the API.
- The server stores the sealed workspace name and wrapped workspace key, plus membership and key-version metadata. The owner is added as the workspace's owner in the same database transaction.
- Opening a workspace fetches the caller's wrapped key and the workspace member directory. The browser unwraps the key and decrypts the name in memory. The workspace key is not persisted to IndexedDB.
- Nonmembers receive a 404 for workspace resources, reducing information exposure about workspace existence and membership.

### Invitations and redemption

- Owners can issue editor or viewer invitations with a one-hour, 24-hour, or seven-day lifetime, list pending invitations, and revoke pending invitations.
- The owner browser generates a random 32-byte invite secret and a UUID invite ID. It derives an invite key using HKDF-SHA-256 and seals the workspace key with AES-256-GCM. The authenticated API receives only the sealed key and invite metadata.
- Invite links use `/join/<inviteId>#<base64url-secret>`. The fragment is not included in HTTP requests. The invite page captures it in memory, validates the invitation, and opens the sealed workspace key locally.
- The invitee wraps the opened workspace key for their own identity and submits that wrapped value. The server uses a transaction and `SELECT ... FOR UPDATE` on the invite row to check expiry, revocation, prior use, and existing membership, then adds the membership and wrapped key and marks the invite used. Concurrent redemption results in one success only.
- Invitees can sign in on the invite page. The invite secret is captured once despite React development Strict Mode effect replay, and the page restores an existing `sessionStorage` session before presenting the sign-in form.

### Membership roles and removal

- The roles are `owner`, `editor`, and `viewer`. Invitations cannot grant owner. Only owners may create/revoke invitations, change member roles, or remove members. Editors and viewers receive 403 for owner-only actions; nonmembers receive 404.
- Role changes are applied through the API and broadcast to connected workspace members. The browser updates the live directory and peer records so sender and receiver policy changes apply without reloading.
- Removal deletes the member's wrapped workspace-key rows and membership row, broadcasts membership removal and peer departure, sends a kick, and closes the removed member's active workspace sockets. A removed account cannot rejoin because the signalling server rechecks membership at join time.
- The workspace UI shows member fingerprints, online presence, verified status, roles, and owner controls. Viewers do not see file-send controls. Receivers reject file offers from a viewer or a peer whose role is missing or unknown, using `no write permission`.

### Authenticated signalling and peer identity

- A WebSocket must authenticate with a valid session token within five seconds. Connections can join only a workspace where the account is a member. Workspace room capacity remains eight peer connections.
- Peer-directory entries carry peer ID, user ID, display name, role, and identity fingerprint. The joining peer creates offers to peers already in the `joined` response; existing peers answer.
- When a WebRTC hello arrives, the client compares its fingerprint to the directory entry. A mismatch marks the connection **identity mismatch**, displays a red badge, and blocks peer application messages. A matching fingerprint plus the Phase 4 sealed `ready` confirmation is required for a secure peer state.
- Authenticated members receive live `member-added`, `member-removed`, `role-changed`, `kicked`, and `peer-left` updates. Multiple tabs may share one identity; the peer UI identifies the same-identity case.
- The server logs workspace/room, shortened peer ID, and event only. It forwards SDP and ICE data without logging their contents. Heartbeat pings detect and terminate dead sockets.

### Existing peer collaboration UI

- The Phase 4 peer interface is now embedded in `/w/[id]` and uses the authenticated workspace ID instead of a free-form room ID.
- Workspace members can join/leave the workspace room, see peer connection and ICE state, inspect direct/relayed candidate information, chat, transfer files, verify peer fingerprints, and inspect debug events.
- The root route redirects to the workspace list. The workspace page retains the signalling status and includes the member and invite management views.

## Database and API

The numbered migration creates the account, workspace, membership, workspace-key, and invite tables, their constraints and indexes, and the migration runner records applied files in `schema_migrations`. Docker Compose initializes PostgreSQL 16 and a separate `zerocloud_test` database for API tests. Dynamic SQL values use parameters; no ORM or workspace-content table was added.

REST endpoints are mounted under `/api`:

| Method   | Path                                | Purpose                                                                |
| -------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `POST`   | `/auth/register`                    | Register an account bound to the local identity fingerprint            |
| `POST`   | `/auth/login`                       | Validate credentials and return the registered fingerprint and session |
| `GET`    | `/me`                               | Return the authenticated account                                       |
| `POST`   | `/workspaces`                       | Create a workspace, owner membership, and self-wrapped key             |
| `GET`    | `/workspaces`                       | List the caller's workspaces                                           |
| `GET`    | `/workspaces/:id`                   | Return a member's wrapped key and member directory                     |
| `POST`   | `/workspaces/:id/invites`           | Create an editor/viewer invite (owner only)                            |
| `GET`    | `/workspaces/:id/invites`           | List pending invites (owner only)                                      |
| `DELETE` | `/workspaces/:id/invites/:inviteId` | Revoke an invite (owner only)                                          |
| `GET`    | `/invites/:inviteId`                | Fetch authenticated invite metadata and sealed workspace key           |
| `POST`   | `/invites/:inviteId/accept`         | Atomically accept an invite and store the caller's wrapped key         |
| `PATCH`  | `/workspaces/:id/members/:userId`   | Change a member's editor/viewer role (owner only)                      |
| `DELETE` | `/workspaces/:id/members/:userId`   | Remove a member and their wrapped keys (owner only)                    |

## Cryptographic data flow

1. **Workspace creation:** the browser generates the workspace key, seals the name with workspace ID in AAD, wraps the key for the owner's identity, then sends only ciphertext and metadata to the API.
2. **Workspace opening:** the server returns the current wrapped key and the wrapper's public identity information to a member. The browser unwraps and opens the name locally.
3. **Invite creation:** the owner creates a secret, derives an invite-scoped key, and seals the workspace key with workspace ID, invite ID, and key version bound in AAD. The link secret remains in the URL fragment.
4. **Invite redemption:** the invitee opens the sealed workspace key using the fragment secret, self-wraps it for their identity, and sends only the wrapped key to the transactional accept endpoint.
5. **Peer connection:** authenticated directory data is checked against the Phase 4 identity-key hello fingerprint. Both peers derive and confirm their session key through the nonce/fingerprint-bound `ready` message before the connection becomes secure.

All new encryption uses browser WebCrypto and existing shared crypto helpers. No custom cryptographic primitives or third-party crypto package were introduced. The shared invite crypto tests cover correct and incorrect secrets and context; workspace crypto tests cover wrapping, self-wrap, wrong recipients, AAD tampering, and sealed names.

## Configuration

The root `.env.example` documents `JWT_SECRET`, `ALLOWED_ORIGIN`, `WEB_ORIGIN`, `TEST_DATABASE_URL`, API and signalling URLs, and the existing STUN/TURN variables. `NEXT_PUBLIC_WEB_ORIGIN` mirrors `WEB_ORIGIN` for browser-generated invite links. TURN values remain browser-visible configuration and should use credentials intended for client use, such as short-lived credentials.

## Verification performed

- Shared package tests: 32 passed.
- Signalling/API tests: 15 passed, including auth timeout, nonmember joins, cross-workspace relay isolation, live role changes, member kicks, and rejoin rejection.
- Web tests: 4 passed, including auto-rejection of viewer and unknown-role file offers.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.

For a local manual run:

```sh
docker compose up -d
pnpm install
pnpm db:migrate
pnpm dev
```

Register an owner account in one browser profile, create a workspace, and make an invite. Open the full invite link in a different browser profile with its own identity, sign in or register, accept the invite, and join the workspace from each profile. Verify chat, peer fingerprint state, and file transfer. Use a viewer invite to confirm that file-send controls are absent, then remove that member as owner and verify the kick and denied rejoin.

## Known limitations retained in this phase

- There is no private-key possession proof at registration, account recovery, key backup, password reset, multi-device identity, or workspace-key rotation.
- Removed members still hold the old workspace key until key rotation is implemented. Removing a member blocks future workspace access and signalling but cannot revoke a key they already received.
- JWTs in `sessionStorage` can be read by JavaScript running through an XSS vulnerability.
- File-role enforcement is cooperative among honest clients; a modified client can bypass its own UI checks.
- The signalling server sees the workspace social graph and online presence. Out-of-band fingerprint verification remains the defence against a malicious server supplying a false peer directory.
- Chat messages remain plaintext at the application layer; this phase's key protection applies to workspace metadata, the peer handshake, and encrypted file transfer as described in the earlier phases.
