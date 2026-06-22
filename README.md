# HevyGarmin

A Node.js service that polls heart rate data from Garmin Connect and tracks it
against your active Hevy workout.

## How it works

- Polls Garmin Connect every `POLL_INTERVAL_MS` (default 5s) for the latest
  heart rate reading.
- Detects your most recent Hevy workout and treats it as the active session.
- Tracks current / average / min / max heart rate across the session, exposed
  via `GET /sync/status`.

## Setup

```bash
npm install
cp .env.example .env   # then fill in real credentials
npm start
```

## Endpoints

| Method | Path              | Description                                  |
|--------|-------------------|----------------------------------------------|
| GET    | `/health`         | Liveness check                               |
| POST   | `/auth/configure` | Override credentials at runtime (JSON body)  |
| POST   | `/auth/test`      | Verify Garmin login + Hevy API connectivity  |
| POST   | `/sync/start`     | Start the polling loop                       |
| POST   | `/sync/stop`      | Stop the polling loop                        |
| GET    | `/sync/status`    | Current sync state + heart rate stats        |

`/auth/configure` body:

```json
{ "garminEmail": "...", "garminPassword": "...", "hevyApiKey": "..." }
```

## Configuration

See `.env.example`. Credentials live in `.env`, which is git-ignored and never
committed.

## Important caveats

These are inherent limitations of the upstream services, not bugs:

1. **Garmin has no public real-time HR stream.** The unofficial Connect API
   only exposes the latest reading once your watch syncs (typically every few
   minutes). "Live" therefore means "the most recent value Garmin knows about,"
   not a true second-by-second feed. A genuinely live feed requires reading the
   watch directly over ANT+/BLE.
2. **The Garmin login is unofficial and brittle.** It mimics the mobile app's
   SSO + OAuth flow and can break whenever Garmin changes it. Accounts with MFA
   enabled cannot log in with username/password alone.
3. **The Hevy API has no live-HR ingestion endpoint.** This service therefore
   accumulates HR stats locally and surfaces them via `/sync/status`; it does
   not write heart rate back into the Hevy workout.

## Process management

In production this runs under pm2:

```bash
pm2 start server.js --name hevy-garmin-sync
pm2 save
```
