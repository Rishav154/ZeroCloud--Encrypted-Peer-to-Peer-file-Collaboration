# ZeroCloud Project Implementation Report: Phases 1–6

## Project overview

ZeroCloud is a browser-based, end-to-end encrypted peer-to-peer collaboration system. Its central design goal is that files are encrypted in the sending browser and transferred directly to authorised peers over WebRTC DataChannels. There is no central file store. The signalling server handles connection setup and workspace authorisation; PostgreSQL stores account and collaboration metadata, never file contents.

The project is a pnpm TypeScript monorepo:

- `apps/web`: Next.js App Router user interface, browser identity, workspace and peer state, WebRTC, and transfer orchestration.
- `apps/signal`: Express HTTP API and WebSocket signalling server, PostgreSQL connection pool, authentication, workspace membership, and migrations.
- `packages/shared`: protocol schemas and types, validation, chunk formats, and WebCrypto helpers shared by the applications.
- `docker/`: PostgreSQL initialization, including creation of an isolated API-test database.

The phases build incrementally: Phase 1 establishes the monorepo and verifies web-to-signal-to-database connectivity; Phase 2 adds peer rooms and live text DataChannels; Phase 3 adds chunked file transfer; Phase 4 encrypts file contents and metadata and adds identity verification; Phase 5 replaces public free-form rooms with authenticated, role-managed workspaces and invitations; Phase 6 adds a local workspace file library and encrypted peer-to-peer synchronization.

## Phase 1: Project foundation

### Aim

Create a runnable monorepo skeleton in which the browser app, signalling server, and PostgreSQL can be started together and their connection can be verified. No WebRTC, cryptography, accounts, or database tables were part of this phase.

### Changes and features

- Added pnpm workspace configuration for `apps/web`, `apps/signal`, and `packages/shared`, shared strict TypeScript settings, formatting and lint configuration, environment examples, root scripts, and setup documentation.
- `packages/shared` defined the initial signalling protocol: `ping` and `pong` Zod schemas/types plus a non-throwing parser for untrusted JSON.
- The signalling service provided Express health checks and a `/ws` endpoint using `ws`. A ping received over WebSocket returned a pong. Invalid protocol input returned an error while preserving the connection. Environment variables were validated at startup; HTTP and WebSocket origins were restricted; shutdown was graceful.
- PostgreSQL 16 ran through Docker Compose with a named volume and healthcheck. The signal process used `pg` with a connection pool. `GET /health` executed `SELECT 1` and reported database state without taking down the process when the database was unavailable. No tables were created in this phase.
- The Next.js page showed signalling status, a ping control, and measured round-trip time. A small socket hook connected to the configured signal URL and retried with exponential backoff. Tailwind and the initial shadcn/ui Button and Card components were added, along with Zustand for client state.
- Root scripts supported concurrent development, build, lint, and type checking.

### Phase boundary

This phase proved service wiring only. The browser did not establish peer connections, encrypt data, authenticate users, or persist application records in PostgreSQL.

## Phase 2: Signalling rooms and WebRTC text chat

### Aim

Allow multiple browser tabs to join a room, establish a direct WebRTC DataChannel mesh, and exchange validated text messages. Files, encryption, authentication, and database tables remained out of scope.

### Protocol and server changes

- Extended the shared protocol with `join`, `leave`, and `signal` client messages and `joined`, `peer-joined`, `peer-left`, and `error` server messages, while retaining ping/pong.
- Validated room IDs against a short alphanumeric/underscore/hyphen format and peer IDs as UUIDs.
- Added in-memory room membership, a limit of eight peer connections per room, target-peer signal relay only within the same room, leave/close cleanup, and deletion of empty rooms.
- Added WebSocket heartbeat handling to ping live sockets and terminate dead sockets. Server logs identify the room, a shortened peer ID, and the event; signalling payloads are not logged.

### Browser peer layer

- Added a framework-agnostic `PeerManager` around native `RTCPeerConnection` and `RTCDataChannel` APIs, with a typed event emitter and a Zustand bridge for React.
- Used a deterministic offer rule to avoid offer collisions: the newly joining peer creates offers to peers returned in its `joined` response; existing peers answer. The offerer creates the ordered, reliable `zc-data` channel, while the answerer handles `ondatachannel`.
- Queued ICE candidates until the remote description was set. Exposed peer connection, ICE connection, DataChannel, and selected candidate-pair state; candidate type was used to label a connection direct or relayed. Failed ICE state triggered one restart attempt before marking the peer failed.
- Configured STUN and optional TURN servers through public environment variables; comma-separated TURN URLs share configured credentials.
- Added per-tab peer IDs, room join/leave controls, validated JSON chat messages, peer state badges, and a collapsible event log. Cleanup closed channels/connections and removed listeners on peer departure and page unload.

### Phase boundary

Phase 2 provided room-level signalling and live text messages only. It had no user accounts, workspace membership, file transfer, or application-level encryption. Phase 5 later replaced these free-form rooms with authenticated workspace rooms.

## Phase 3: Chunked file transfer over DataChannels

### Aim

Transfer files reliably over existing DataChannels without loading a whole file into memory for sending. The initial Phase 3 payload was plaintext at the application layer so Phase 4 could add an encryption transform without rebuilding the transfer pipeline.

### Wire format and transfer lifecycle

- Added shared Zod schemas for `file-offer`, `file-accept`, `file-reject`, `file-complete`, `file-ack`, and `file-cancel` control messages.
- Binary chunks used an eight-byte big-endian header: uint32 transfer ID followed by uint32 chunk index, then chunk data. Shared pack/unpack helpers validated the header and rejected undersized buffers.
- Standardized chunks at 16 KiB and enforced a 500 MiB maximum file size. The zero-byte case used an offer/complete/ack flow with no chunks.
- The sender computed the whole-file SHA-256 digest before offering a file, then read slices lazily with `file.slice(...).arrayBuffer()`. A transfer waited for receiver acceptance, streamed ordered chunks, and waited for an acknowledgement after completion.
- Backpressure bounded queued DataChannel data: the channel used a buffered-low threshold of 256 KiB, and send loops waited when buffered data exceeded about 1 MiB. Offers timed out after 60 seconds without a response.
- One outgoing transfer per peer ran at a time; further files for that peer queued FIFO. Sending to several peers used an independent transfer per peer so one peer's failure did not cancel others.
- The receiver validated metadata and chunk counts, required in-order chunks, tracked received bytes, enforced the declared size, rebuilt a Blob after all chunks arrived, and compared the final SHA-256 digest. It exposed accept/decline and download actions and cleaned up memory on completion, cancellation, failure, disconnect, or peer departure.
- Both sides supported cancellation, channel-close failure handling, transfer progress, smoothed throughput, ETA, and transfer events in the debug panel.
- Introduced a shared `ChunkTransform` interface and an identity transform. Sender and receiver always passed data through that interface so Phase 4 could replace the transform with AES-GCM.

### Phase boundary

Phase 3 added no application-layer file encryption, authentication, or database persistence. It established lazy reads, bounded backpressure, integrity checking, transfer state, and cleanup that Phase 4 retained.

## Phase 4: End-to-end encryption and peer identity

### Aim

Encrypt file content and file metadata before they leave the sending browser, use browser WebCrypto only, and give users a fingerprint verification flow. Private identity keys remain local and are never sent to signalling.

### Browser identity and fingerprint verification

- Generated one ECDH identity key pair per browser profile, preferring X25519 when WebCrypto supports it and falling back to P-256. The non-extractable private `CryptoKey` and public key are persisted through IndexedDB structured cloning; the private key is never exported.
- Computed a stable SHA-256 fingerprint from the raw public key, displayed grouped hex, and provided copy and reset controls. Verified peer fingerprints are stored locally in IndexedDB. The verify dialog shows both full fingerprints; the UI labels peers verified or unverified.
- Tabs in one browser profile share the same stored identity. The peer row explicitly labels that same-identity case instead of treating it as a handshake failure.

### Handshake and sealed envelopes

- Each DataChannel exchanges a Zod-validated `hello` with protocol version, curve, raw public key in base64, and a fresh 32-byte `crypto.getRandomValues` nonce. A nonce with the wrong length or a second hello on the same channel is rejected.
- Session key derivation uses ECDH followed by HKDF-SHA-256 with info `zerocloud/v1/session`. For symmetry, the public keys are sorted bytewise independently from the nonces; each value is length-prefixed in the salt input: `SHA-256("zerocloud/v1/salt" || lenPrefix(pubA) || lenPrefix(pubB) || lenPrefix(nonceA) || lenPrefix(nonceB))`.
- Each side sends an AES-256-GCM sealed `ready` confirmation. AAD binds the message context, both fingerprints, both nonces, direction, and optional transfer ID; the peer becomes secure only after the incoming confirmation opens successfully. A session key is newly derived for every DataChannel.
- Shared seal/open helpers use a fresh random 12-byte IV per envelope and AES-GCM authentication tags. Envelopes are represented as IV followed by ciphertext and tag. No custom crypto primitives or third-party crypto package were introduced.

### Encrypted file pipeline

- A fresh AES-256-GCM file key is created per transfer. The file offer's name, MIME type, size, chunk parameters, plaintext SHA-256, and raw file key are sealed with the peer session key; the DataChannel does not carry the filename or file key in plaintext.
- Replaced the identity transform with `AesGcmChunkTransform`. Each transfer has a distinct file key and one transform instance. The transform receives `totalChunks` and `transferId`; its IV includes the chunk index and its AAD binds transfer ID, index, and total chunk count. AES-GCM ciphertext adds a 16-byte tag to each plaintext chunk.
- The receiver validates the expected encoded and plaintext chunk lengths, decrypts in order, recomputes SHA-256 on the resulting plaintext file, and discards data immediately on authentication or integrity failure. The final plaintext digest remains an independent corruption check.
- Control messages contain only transfer IDs and small state/reason values. A debug wire-tap can show ciphertext prefixes and sizes; a development tamper flag can flip a chunk bit to verify failure handling. Neither mode logs keys or plaintext.

### Phase boundary and limitations

Phase 4 did not add accounts, workspace membership, or a server-side identity directory. Static identity keys provide no forward secrecy across sessions; clearing site data loses the identity; fingerprints must be checked out of band to defend against a malicious signalling server. Chat remains plaintext at the application layer.

## Phase 5: Accounts, workspaces, invites, and authorised signalling

### Aim

Phase 5 replaces unauthenticated, free-form signalling rooms with account-owned workspaces. It binds each account to one browser identity, lets the workspace owner invite other identities without exposing the workspace key to the server, and restricts signalling and workspace administration to current members.

The data-plane design remains peer-to-peer: encrypted file content travels directly over WebRTC DataChannels. The signalling server coordinates connections and relays WebRTC offer, answer, and ICE messages; PostgreSQL stores account and workspace metadata, sealed names, wrapped keys, and invite state. The server does not receive private identity keys, plaintext workspace keys, invite secrets, file names, or file content.

This phase was implemented in two checkpoints. Checkpoint A added account, identity, workspace, and key-wrapping foundations. Checkpoint B added invitations, roles, authenticated workspace signalling, live membership updates, and role enforcement in the existing peer/file-transfer experience.

### Features implemented

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

### Database and API

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

### Cryptographic data flow

1. **Workspace creation:** the browser generates the workspace key, seals the name with workspace ID in AAD, wraps the key for the owner's identity, then sends only ciphertext and metadata to the API.
2. **Workspace opening:** the server returns the current wrapped key and the wrapper's public identity information to a member. The browser unwraps and opens the name locally.
3. **Invite creation:** the owner creates a secret, derives an invite-scoped key, and seals the workspace key with workspace ID, invite ID, and key version bound in AAD. The link secret remains in the URL fragment.
4. **Invite redemption:** the invitee opens the sealed workspace key using the fragment secret, self-wraps it for their identity, and sends only the wrapped key to the transactional accept endpoint.
5. **Peer connection:** authenticated directory data is checked against the Phase 4 identity-key hello fingerprint. Both peers derive and confirm their session key through the nonce/fingerprint-bound `ready` message before the connection becomes secure.

All new encryption uses browser WebCrypto and existing shared crypto helpers. No custom cryptographic primitives or third-party crypto package were introduced. The shared invite crypto tests cover correct and incorrect secrets and context; workspace crypto tests cover wrapping, self-wrap, wrong recipients, AAD tampering, and sealed names.

### Configuration

The root `.env.example` documents `JWT_SECRET`, `ALLOWED_ORIGIN`, `WEB_ORIGIN`, `TEST_DATABASE_URL`, API and signalling URLs, and the existing STUN/TURN variables. `NEXT_PUBLIC_WEB_ORIGIN` mirrors `WEB_ORIGIN` for browser-generated invite links. TURN values remain browser-visible configuration and should use credentials intended for client use, such as short-lived credentials.

### Verification performed

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

### Known limitations retained in this phase

- There is no private-key possession proof at registration, account recovery, key backup, password reset, multi-device identity, or workspace-key rotation.
- Removed members still hold the old workspace key until key rotation is implemented. Removing a member blocks future workspace access and signalling but cannot revoke a key they already received.
- JWTs in `sessionStorage` can be read by JavaScript running through an XSS vulnerability.
- File-role enforcement is cooperative among honest clients; a modified client can bypass its own UI checks.
- The signalling server sees the workspace social graph and online presence. Out-of-band fingerprint verification remains the defence against a malicious server supplying a false peer directory.
- Chat messages remain plaintext at the application layer; this phase's key protection applies to workspace metadata, the peer handshake, and encrypted file transfer as described in the earlier phases.

## Phase 6: Workspace file library and peer-to-peer sync

### Aim and boundaries

Give each workspace member a persistent local file library and make authorized peers converge while their browser tabs are open. Manifests, deltas, and pull requests travel over the already key-confirmed WebRTC DataChannel. A peer that lacks a file requests its blob from a member advertising the exact version; files continue through the Phase 3/4 encrypted transfer pipeline. Quick send remains a separate ad-hoc feature.

The work was split into Checkpoint A (local library) and Checkpoint B (sync). The signalling service and database schema were not changed for Phase 6. The server does not receive file names, sizes, hashes, file IDs, manifest entries, or file content.

### Shared file model and convergence

- Added pure TypeScript types, Zod schemas, version comparison, manifest diffing, and local create/replace/delete helpers in `packages/shared/src/sync/`.
- A `FileEntry` uses a stable UUID `fileId` and contains a flat file name, size, plaintext SHA-256, Lamport counter, author fingerprint and display name, display-only modification time, and a deletion flag. Tombstones have size zero and an empty hash.
- Versions are ordered by `(lamport, author)`; the larger tuple wins, with author compared lexicographically as a deterministic tie-breaker. `modifiedAt` does not participate. A local edit advances the workspace Lamport clock beyond the largest value observed; adopting remote metadata preserves its original author and counter.
- `diffManifests` validates entries and current writer authorship, then classifies newer live content as a pull, newer tombstones or same-content metadata as an adopt, and older/equal remote versions as ignore. A live file with a higher version can resurrect a tombstone. Invalid entries and entries attributed to a viewer are rejected.
- Enforced the 500-entry workspace limit (including tombstones), 500 MiB file limit, and 1 MiB total manifest metadata limit. Same-named files retain separate identities; the Files UI shows an author suffix when multiple live entries share a name.

### Local IndexedDB library and Files tab

- Added a raw IndexedDB wrapper in `apps/web/src/lib/store/fileLibraryDb.ts`; no ORM was introduced. The database has `entries` keyed by `[workspaceId, fileId]`, `blobs` keyed the same way and storing `{ sha256, blob }`, and `meta` keyed by workspace ID for the Lamport high-water mark.
- Local status is derived from the entry and blob digest: `present`, `missing`, or `tombstone`. File writes place the blob and entry in the same transaction; a failed replacement preserves the previous committed pair. Deletion atomically writes a tombstone and removes the local blob. Remote adoption and completed pulls also guard against overwriting a newer local version.
- Uploads hash in the browser with WebCrypto before saving. The Files tab supports drag-and-drop and picker upload, replace or keep-both choices for same-named files, confirmed deletion, hidden tombstones with a Show deleted toggle, download from a local blob, status and author/time columns, and a browser storage usage meter with an 80% warning. Writers can change files; viewer controls are hidden and the storage API also refuses viewer writes.
- Quota failures produce a readable storage-full error and abort the transaction. A development-only simulated quota failure makes this path reproducible. Browser IndexedDB file blobs are plaintext at rest in this phase.

### Encrypted sync protocol and authenticated header

All sync is restricted to peers whose Phase 4 handshake is key-confirmed and whose workspace-directory role is known. A strict Zod schema validates each incoming sync header before decryption. The DataChannel wire form is:

```json
{
  "type": "sync",
  "header": {
    "v": 1,
    "messageType": "manifest",
    "workspaceId": "…",
    "syncId": "32 lowercase hex characters",
    "partIndex": 0,
    "totalParts": 1,
    "seq": 1
  },
  "sealed": "base64 AES-GCM envelope"
}
```

The header contains only the listed fields: no names, hashes, sizes, file IDs, or entries. It must have version 1, a recognized message type, the current workspace UUID, a 32-character lowercase hex sync ID, `partIndex < totalParts <= 64`, and a positive uint32 sequence. A well-formed message for a different workspace is silently discarded before any decryption work. The entire wire message, header included, is limited to 16 KiB.

Payload types are:

| Payload        | Validated contents                                                                        | Use                                                                |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `manifest`     | Sync ID, fragment index/count, and entries in fragments of at most 12,000 plaintext bytes | Full metadata exchange on a secure connection                      |
| `delta`        | Sync ID and at most 20 `FileEntry` values                                                 | Announce a local writer change; reconcile the winner with the peer |
| `pull-request` | Request ID, file ID, expected SHA-256                                                     | Ask a member that advertised this version for its local blob       |
| `pull-denied`  | Request ID and `not-found`, `hash-mismatch`, or `forbidden` reason                        | Report why a pull was not served                                   |

The sender seals each JSON payload using the Phase 4 session key and AES-GCM. Receiver-side AAD is built from the received header and the fingerprints of the handshake-confirmed connection, in the approved order:

```text
"zerocloud/v1/sync" || messageType || workspaceId || syncId ||
partIndex || totalParts || seq || senderFingerprint || receiverFingerprint
```

The three integer fields are encoded as unsigned 32-bit big-endian values; the fixed-format identifiers and fingerprints are UTF-8 bytes. The receiver gets fingerprints from the confirmed peer context, never from the header or server directory. Any change to an authenticated header value or either fingerprint makes AES-GCM open fail. DataChannels are additionally protected by WebRTC DTLS.

`seq` is a per-sender, per-connection counter starting at 1. It advances once per sync message; all fragments of one manifest share one sequence. The receiver rejects sequence numbers at or below the highest accepted value, allowing only distinct indexes within the currently accepted manifest group at that same sequence. Sequence and replay state reset on a new connection, which has a fresh session key.

Manifest reassembly is keyed by peer connection and sync ID. It accepts up to 64 fragments and 1 MiB of metadata, expires incomplete assemblies after 30 seconds, ignores duplicate indexes and stale completed IDs, and discards the assembly if a fragment fails authentication. A 12,000-byte plaintext fragment cap keeps the encrypted base64 wrapper within the 16 KiB wire cap.

### Sync lifecycle, pulls, and live UI

- When a peer reaches secure state with a known role, each side sends its complete manifest. The receiver reassembles it, runs `diffManifests` against its local entries using the current workspace member directory, adopts newer metadata/tombstones, requests missing content, and sends its winning version back when the remote manifest is older. Delta processing uses the same comparison path, so the deterministic winner propagates without an echo once both peers hold the same version.
- A pull responder must be a known workspace member and have a local blob whose stored digest exactly matches the request. Viewers may serve and receive sync pulls, while writer authorship is required for changes. Ad-hoc file offers still require a writer sender.
- A sync-purpose file offer is auto-accepted only when its request ID, peer connection, expected size, and expected SHA-256 match an outstanding pull. An unsolicited or otherwise unmatched offer follows the existing manual Quick send flow. The receiver verifies the final plaintext digest before atomically committing the blob with its entry.
- The pull queue runs at most four transfers in total and two per peer. It retries up to three times with exponential backoff, rotates among peers advertising the same version, requeues on disconnect, and exposes a manual Retry action for failed items. Timers, expectations, listeners, and peer work are cleared on disconnect/removal, kick, workspace teardown, or page cleanup.
- The Files tab shows Offline, Syncing, or In sync summaries and row states for queued, pulling with percent, failed, synced, missing, present locally, and deleted entries. The peer list adds a per-peer sync state; the collapsible debug events include sync outcomes and the SHA-256 state hash over sorted local entries.
- `NEXT_PUBLIC_DEBUG_FORGE_VIEWER=true` enables a development-only viewer control that attempts to publish an invalid viewer-authored delta. The receiver rejects it through current writer validation. Writers also get a development-only random create/replace/delete simulation capped at 60 seconds for multi-peer convergence checks.

### Phase 6 tests and verification

- Shared tests cover version ordering, manifest diffs, Lamport changes, metadata adoption, fragmentation and reassembly, all sync AAD fields (including sender/receiver fingerprints), cross-connection replay, strict headers, workspace rejection, oversized envelopes, sequence replay/lower-sequence rejection, and a deterministic four-peer convergence simulation over 200 seeds.
- Web tests cover IndexedDB persistence, atomic replacement and quota failure, remote metadata adoption, hash-verified pulled files, manifest reassembly/timeout/duplicate/stale behavior, pull authorization (including viewers and unknown roles), offer matching, and viewer/unknown-role transfer rejection.
- Final verification: shared 47 tests, signalling 15 tests, and web 18 tests passed; `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed. The deterministic convergence simulation completed in under 10 seconds in the test run.
- Manual two-profile browser sync was not exercised as part of this implementation pass. README documents the local two-profile check, offline catch-up, digest comparison, and debug state hash workflow.

### Known limitations

- Last-writer-wins silently discards the losing concurrent edit; there is no conflict UI or version history. A malicious writer can forge another writer's fingerprint in metadata because entries are not individually signed.
- Files remain plaintext in local IndexedDB. Sync runs only while browser tabs are open; background sync, key rotation, folders, rename, and tombstone garbage collection are out of scope.
- A removed member retains files and workspace keys already copied. The server learns which workspace members are online, but sync headers and payloads travel over the peer DataChannel and no file metadata is sent through signalling or persisted server-side.
