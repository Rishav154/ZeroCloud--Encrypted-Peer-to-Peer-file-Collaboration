# ZeroCloud

ZeroCloud is a browser-based, end-to-end encrypted peer-to-peer file collaboration project. Phase 1 provides the monorepo foundation, a signalling health endpoint and ping/pong, and PostgreSQL connectivity. No WebRTC, encryption, authentication, or database tables are included yet.

## Requirements

- Node.js 20 or newer
- pnpm 10
- Docker Compose

## Local setup

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm dev
```

The web app runs at <http://localhost:3000>; the signalling server runs at <http://localhost:4000> and its WebSocket endpoint is `ws://localhost:4000/ws`.

Check database connectivity with:

```sh
curl http://localhost:4000/health
```

The response includes server uptime and reports `db: "up"` when PostgreSQL answers `SELECT 1`. The home page's **Send ping** button measures a signalling round trip. Stop and restart PostgreSQL or the signal server to see the health and reconnect states.

## Quality commands

```sh
pnpm build
pnpm lint
pnpm typecheck
```

## Environment

Copy `.env.example` to `.env` and set local database credentials. `ALLOWED_ORIGIN` must match the browser app origin. `NEXT_PUBLIC_SIGNAL_URL` is the WebSocket URL consumed by the browser.
