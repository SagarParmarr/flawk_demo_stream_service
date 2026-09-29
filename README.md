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


## Demo lifecycle and selected playback

`SELECTED_ASSET_HOLD_SECONDS` defaults to 30 and accepts integer values from 20 through 30. The selected publisher loops until the deadline measured from confirmed IVS takeover. Fresh valid decisions switch directly to another selected asset; a fresh same-asset decision renews the window without republishing. Duplicate decisions and no-decision outcomes do not renew it. At expiry the coordinator restores its cached default source. Failed default restoration ends the Demo.

Mobile clients send `mobile_presence_required: true` on `POST /demo-streams`. Existing clients omit it and retain their previous lifetime policy. Opted-in clients call owner-authenticated `POST /demo-streams/:id/heartbeat` every 10 seconds; absence for 60 seconds stops both downstream sessions. The lease is enforced during startup, recovery, and live playback independently of upstream polling. Expired/stopping/terminal Demos cannot be renewed.

Status responses additionally include nullable `selected_expires_at` and `presence_expires_at`. These are persisted in SQLite JSON payloads; older records normalize missing fields to null without a table migration. Stop returns 202 and may report `stopping`; clients retain their pending-stop reference until terminal confirmation.

Deploy the backend before distributing the updated mobile client. Local tests do not verify physical auto-lock behavior, background/gesture navigation, real IVS takeover, or HLS playback latency. Validate these on physical iPhone/Android and a target screen with the same session and playback URL through default → selected A → selected B → default. Record shutdown reason, expiry, and failed-switch logs without credentials.

## Timing logs

The service writes structured JSON to stdout through Fastify's logger. Each `demo_timing` span has a `stage`, unique `spanId`, `outcome` (`started`, `completed`, or `failed`), UTC ISO `startedAt`/`endedAt`, and `durationMs`. Durations use a monotonic clock so system clock adjustments do not distort them. Match started and finished records by `spanId`; correlate the pipeline by `demoId`, `adaptiveSessionId`, `goLiveSessionId`, and, for a selection, `decisionId`/`assetId`/`cycleNumber`. Starts remain visible if a process dies before a stage finishes.

| Stage / event | What it measures |
| --- | --- |
| `laravel_session_validation` | Laravel capture-session validation API round trip (before a Demo ID exists). |
| `go_live_session_create` | Go-Live create-session API round trip, including any resource provisioning performed by that endpoint. |
| `laravel_session_bind` | Binding the capture session to this Demo and Go-Live session. |
| `go_live_publisher_acquire` | Publisher-credentials API round trip. |
| `s3_metadata` | Default object's S3 metadata request for cache invalidation. |
| `demo_media_cache` | `cacheHit: true/false`; a hit skips download. |
| `s3_download` | AWS CLI download to local cache; only emitted on a cache miss. |
| `media_probe` | FFprobe process execution to inspect tracks and duration. |
| `default_media_prepare` / `selected_media_prepare` | Entire preparation, including metadata/download/probe and filesystem work. |
| `ffmpeg_spawn` | FFmpeg process creation; this alone does not prove successful encoding or ingest. |
| `ffmpeg_first_encoded_frame` | Process launch to first nonzero frame progress report (sampled every 0.5 seconds). Encoding and RTMPS publishing run continuously; this is not a separate complete-file conversion or confirmation of IVS receipt. |
| `ivs_initial_live_confirmation` | Go-Live start API round trip, which confirms initial IVS activation. |
| `session_request_to_ivs_live` | Initial successful request, including validation and session creation, through confirmed default IVS playback; emitted before content reporting. Reused sessions do not emit a new startup duration. |
| `startup_pipeline` / `recovery_pipeline` | Background startup/recovery, through content reporting and launching decision polling. Startup excludes the preceding validation/create calls. |
| `laravel_decision_poll` | Decision-feed API round trip; debug level to avoid logging every idle poll at info level. |
| `demo_decision_received` | UTC arrival time, result, cycle and asset IDs for each fresh decision. |
| `decision_handling` / `demo_decision_handled` | Handling a choice after feed receipt, including preparation, waiting and switching. The result event distinguishes `switched`, `renewed` (same asset, no new publisher) and `skipped`; a completed handling span alone does not prove a switch. |
| `publisher_lock_wait` | Waiting for earlier switch/restoration tasks after preparation. |
| `ivs_status_baseline` | Pre-switch IVS status API round trip. |
| `ivs_takeover_confirmation` | Waiting/polling for a new IVS takeover event after replacement FFmpeg spawn. |
| `demo_source_switched` | `confirmedAt` for authoritative switch, with previous and new asset IDs/types. |
| `asset_transition` | Switch start through baseline, spawn, confirmation, old publisher stop and content reporting; excludes S3 preparation. Includes return to cached default. |
| `previous_publisher_stop` / `go_live_content_report` | Old publisher shutdown and reporting current content to Go-Live. |
| `go_live_session_stop` / `laravel_session_stop` | Downstream stop API round trips (including retry attempts). |
| `demo_publisher_exit` | Process lifetime, exit code/signal, and whether any encoded frame was observed. |

Nested durations overlap: do not add a pipeline span to its child spans. Use `demo_decision_received.receivedAt` and `demo_source_switched.confirmedAt` to see choice arrival → confirmed asset takeover. Use successive switch timestamps to measure how long each asset stayed active. Failed stages log elapsed time and only the error class; existing error logs indicate the affected workflow. Interrupted startup/recovery does not report a completed pipeline.

Locally, logs appear in the terminal running `npm run dev` or `npm run start:prod`. With the supplied systemd unit:

```sh
journalctl -u flawk-demo.service -f -o cat
# Filter one Demo's events (replace the ID):
journalctl -u flawk-demo.service --since '30 minutes ago' -o cat | jq -R 'fromjson? | select(.demoId == "demo_YOUR_ID")'
```

Info logs are enabled by default. Set `LOG_LEVEL=debug` in the service environment and restart it when individual polling timings are needed. These changes do not install a file logger or log collector. Retention follows the terminal/process manager/journald configuration.

Measurement boundaries: Laravel currently returns no inference start/end or decision-created timestamp, so this service cannot measure capture → LLM decision or feed-delivery lag. The Go-Live endpoint durations do not isolate AWS channel creation from its other work or indicate whether a channel was reused. Those timings require instrumentation in Laravel and the Go-Live backend. IVS confirmation does not measure when an HLS player displays the frame; that requires player-side instrumentation. No bearer tokens, S3 URLs/keys, ingest URLs, stream keys, raw error messages, or FFmpeg stderr are added to these logs.
