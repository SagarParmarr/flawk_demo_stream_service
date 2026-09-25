# Flawk Demo Stream Service

Backend-only coordinator for one-screen, one-frame Demo sessions. Laravel owns capture and LLM decisions; Node owns Go-Live sessions and IVS; this service owns FFmpeg publishing and takeover. No browser UI or stream key is exposed to mobile.

## Flow

1. Mobile creates an authorized Laravel adaptive session.
2. `POST /demo-streams` verifies that session, reserves one active Demo per owner, and creates a Node Go-Live session while the mobile bearer is still request-scoped. It returns `202`; background work binds all three IDs in Laravel and starts publishing.
3. The service caches the default S3 MP4 and starts FFmpeg. Node marks the Go-Live session live only after AWS IVS `GetStream` confirms it.
4. Every two seconds the service reads decisions for the bound capture session. Decisions are ordered by capture cycle. It marks each cycle processed before attempting a switch, so a restart cannot replay an old decision.
5. A selected MP4 takes over the same IVS stream at a higher priority. The old publisher stays alive until IVS reports a takeover event. Near the selected clip's loop boundary, the default publisher takes over again.
6. Stop and the 30-minute limit terminate FFmpeg, then stop Node and Laravel. Partial cleanup remains in `stopping` and retries.

The playback URL stays the Node channel's IVS `.m3u8` URL. `GET /demo-streams/{id}` reports the confirmed source; `operation` describes any ongoing switch. One selected clip consumes two takeovers, so the service stops accepting choices when fewer than two of its 90 safe slots remain.

## Structure

- `src/api`: validation and HTTP responses.
- `src/application`: lifecycle, polling, takeover, and recovery.
- `src/domain`: state and interfaces.
- `src/integrations`: Laravel, Node, S3, and FFmpeg clients.
- `src/infrastructure`: configuration and WAL-mode SQLite persistence.

Run `npm ci`, `npm run check`, `npm test`, and `npm run build` with Node 22.13 or newer. For local development, load a noncommitted `.env` through your shell or process manager, then run `npm run dev`. `npm start` uses Node's SQLite flag for Node 22.

## Required configuration

Copy `.env.example` into managed server configuration. `DEMO_STREAM_SERVICE_SECRET` must match Laravel, and `GO_LIVE_ADAPTIVE_INTERNAL_SECRET` must match Node; both must be at least 32 characters and come from managed secrets storage. Keep `HOST=127.0.0.1` behind an HTTPS reverse proxy. Give the EC2 instance role read access only to the configured media bucket. The service uses AWS CLI, FFmpeg, and ffprobe on `PATH`.

In the mobile build, set `EXPO_PUBLIC_DEMO_STREAM_ENABLED=true` and `EXPO_PUBLIC_DEMO_STREAM_API_BASE_URL=https://<dedicated-hostname>`. The URL must be HTTPS. Until both are set, the existing Demo path stays active. Disable `ADAPTIVE_IVS_PLAYOUT_ENABLED` in Laravel for EC2-owned sessions, and deploy the Laravel binding/decision routes and Node internal publisher routes before enabling the mobile flag.

Do not use an HTTP public IP for bearer-bearing mobile requests. The bundled `systemd` and Nginx files are templates; set actual paths, host, certificates, and service account before installation.

## Recovery and operations

SQLite stores the Demo ID, Laravel ID, Node ID, state, cursor, and takeover count. It never stores bearer tokens or IVS stream keys. On graceful shutdown, the coordinator stops its local FFmpeg process groups but keeps downstream sessions for recovery; `systemd` also kills any remaining processes in its cgroup. On restart, the coordinator rebinds an interrupted Laravel session if needed, reacquires publisher credentials, restores default playback, confirms IVS, and resumes from the saved decision cursor. Sessions beyond 30 minutes or with invalid upstream state are stopped.

Use `/health/live` for process liveness and `/health/ready` for startup readiness. Logs contain Demo IDs and error classes, with authorization headers redacted. If a session stays in `stopping`, check Node and Laravel availability; retries continue every five seconds. If a switch fails, the confirmed current publisher remains active. A failed return to default is retried on the next poll.

Production rollout should verify one physical phone and screen: default first, selection takeover, stable HLS URL, later decision, no-decision behavior, Stop, duplicate taps, and service restart. Local tests do not prove AWS publisher connectivity or physical playback.

The once-only clip boundary is best effort: IVS takeover confirmation has variable latency. The selected FFmpeg input remains looped until default takeover is confirmed so a slow or failed return cannot interrupt the live stream. Frame-exact once-only playback would require a playout pipeline that can concatenate sources without waiting for a second IVS takeover.
