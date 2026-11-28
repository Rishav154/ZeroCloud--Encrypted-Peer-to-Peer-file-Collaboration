# Anonymous Nearby deployment verification

These checks require a deployed web app and signal server. Run the protocol and integration tests in CI first. Do not use a production deployment for the load check unless its operator has approved a brief 11-socket test.

## Socket cap load check

The script uses safe default caps: 10 concurrent sockets per IP, 20 new connections per minute per IP, 30 peers per group, and 2000 sockets globally (`NEARBY_MAX_SOCKETS`). It opens 10 sockets from one client and expects the 11th to receive HTTP 429. It then closes all opened sockets.

```sh
pnpm test:load-nearby wss://signal.example.com/ws/nearby
```

In a controlled staging deployment, set `NEARBY_MAX_SOCKETS=5` and run `pnpm test:load-nearby wss://signal.example.com/ws/nearby --global-cap 5`. The next socket should close with code `4425` and reason `Nearby global capacity reached (NEARBY_MAX_SOCKETS)`. The script accepts test caps 1–9 so the per-IP cap does not interfere. Do not run global-cap mode against production.

Record deployment, UTC time, configured cap, number of opened sockets, refusal status or close code and reason, and whether every accepted socket closed cleanly.

## Two-device transfer and database check (criteria 1)

1. Record PostgreSQL row counts for every application table before testing. For this schema, use:

   ```sql
   SELECT 'users' AS table_name, count(*) FROM users
   UNION ALL SELECT 'workspaces', count(*) FROM workspaces
   UNION ALL SELECT 'workspace_members', count(*) FROM workspace_members
   UNION ALL SELECT 'workspace_keys', count(*) FROM workspace_keys
   UNION ALL SELECT 'invites', count(*) FROM invites
   ORDER BY table_name;
   ```
2. Open the deployed site in a fresh browser profile on a laptop and a phone on the same Wi-Fi. Neither browser should have an account.
3. Confirm both devices become visible and list one another within three seconds.
4. Connect, send a 20 MB file, manually accept it, and save it on the receiver.
5. Compare `sha256sum` of the source and received files.
6. Run the query again. Record device/browser versions, elapsed discovery and transfer time, file size, both SHA-256 values, and before/after row counts. No row count should change because of Nearby.

## Invite handoff (criterion 6)

1. Sign in as a workspace owner on one device and keep an account-free Nearby session visible on the second.
2. Send an invite to the second device and accept it. Complete sign-in or registration without reloading the page.
3. Confirm the chosen role and workspace membership after redemption.
4. Confirm the sender's existing pending-invite list reflects the invite's final status; it is the source of truth, while `invite-ack` is best-effort. Inspect browser URLs, localStorage, and server logs for the invite secret; it must appear in none of them. Record invite ID, chosen role, membership result, pending-list status, and checks performed. Do not record the secret.

## Logs and privacy (criterion 8)

1. Run an anonymous Nearby session and connect two peers.
2. Review application and reverse-proxy logs for raw IP addresses, complete group keys, account identifiers, and invite secrets.
3. Confirm `/health` exposes only anonymous Nearby counts (`sockets`, `enabled`, `groups`), with no peer IDs or group keys. Record the log sources and review interval.

## Proxy grouping (criterion 9)

1. Confirm `TRUST_PROXY_HOPS` matches the number of trusted reverse-proxy hops. `0` uses the direct socket address; the default is `1`.
2. Open `/preflight` on both same-network devices while Nearby is visible.
3. Confirm both report the same six-character group ID and expected member count. Record the configured hop count and both readings.

Origin checks deter casual browser abuse; they are not authentication and do not prevent scripted clients. The anonymous socket limits reduce resource abuse but cannot eliminate denial-of-service risk.
