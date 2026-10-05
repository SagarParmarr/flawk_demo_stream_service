# EC2 persistent publisher deployment — 2026-10-05

Host: existing `New-Dev-Flawk-CMS` SSH alias, Amazon Linux 2023.
Service checkout: `/opt/flawk/flawk_demo_stream_service`.
CMS checkout: `/var/www/html/flawk-cms`.

## Native runtime

Installed `cmake`, `json-c-devel`, and the existing OpenSSL development dependency.
Built FFmpeg 5.1.7 shared development libraries under `/opt/flawk-ffmpeg-libs/5.1.7`.
This library build includes MOV input, FLV output, file/pipe/TCP/TLS/RTMP/RTMPS protocols and OpenSSL, with no encoders or decoders. Offline preparation still uses `/opt/flawk-ffmpeg/8.1/bin/ffmpeg` and its matching ffprobe.

`/etc/ld.so.conf.d/flawk-publisher.conf` registers the library directory; `ldconfig` makes it available to the service user. Future clean builds on this host use:

```sh
cd /opt/flawk/flawk_demo_stream_service
PKG_CONFIG_PATH=/opt/flawk-ffmpeg-libs/5.1.7/lib/pkgconfig npm run build:all
PATH=/opt/flawk-ffmpeg/8.1/bin:$PATH npm test
PATH=/opt/flawk-ffmpeg/8.1/bin:$PATH npm run test:publisher
```

Linked native versions are recorded in `native/build/dependencies.json`. Both systemd services use Node 22.23.3 from `/usr/local/bin/node`.

## Configuration and assets

`/etc/flawk-demo/demo.env` enables persistent publishing, uses the requested prepared default URI, and sets the absolute native helper path. `/etc/flawk-demo/media.env` sets the same helper path.

CMS explicitly selects `ADAPTIVE_MEDIA_PREPARATION_PROFILE=square800-copy-v2`; it defaults to v1 in code. Migration `2026_10_05_000001_add_adaptive_preparation_profile.php` persists the chosen preparation profile for each queued generation. Claim, completion and output keys use that saved value. Completion rejects a profile that differs from its job. CMS accepts previews and completion for both supported profiles.

The supplied default originally contained High-profile video, B-frames and 48 kHz audio. It was regenerated offline as Main 3.2/no B-frames/44.1 kHz AAC, padded to a complete 10-second loop, strictly validated, and uploaded at the requested URI with the v2 marker. Five existing active ads were queued through the actual CMS → Node worker → S3 → CMS completion flow.

A real-asset smoke test found inherited `bt470bg` color metadata on one ad. V2 preparation now normalizes color configuration to BT.709; legacy preparation is unchanged. The default and ads were regenerated again with this correction.

## Backups and rollback

Root-only backups of service ENV, CMS ENV/source and pre-regeneration asset records are under `/var/backups/flawk-persistent-20261005`. Original ad objects remain at their previous S3 keys. The original default is backed up at `flawk_cms/adaptive_assets/backups/persistent-20261005/default-original.mp4`; the legacy default setting uses that object so the v2 default does not prevent rollback.

Setting `DEMO_PERSISTENT_PUBLISHER_ENABLED=false` and restarting selects legacy mode for new Demos, but saved persistent sessions retain their mode. Existing v2 ads are rejected by legacy mode: restore the old ad keys/profiles from the asset-record backup or explicitly regenerate them as v1 before expecting selected-ad playback after rollback. Set the independent CMS preparation profile to v1 for future preparation. Keep the helper installed until all saved persistent Demos end.

## Verification boundaries

EC2 validation includes TypeScript checking/build and 64 passing regression tests. The final native tests passed 100 switches with one PID, continuous A/V, first-packet identity, stable 14,732 KiB peak RSS and decoded FLV, plus a stalled TLS handshake exit after about 5.6 seconds. A separate test switched the real default through all five regenerated CMS ads and back with one PID; all six commitments took 1.99–2.02 seconds and the output decoded successfully. Deployment readiness and the default's actual S3/cache validation were checked with deployed configuration.

Native switch commitment is an output-writer acknowledgement, not proof of visible Fortinet playback. Physical-device fresh starts and the full viewer canary require a selected screen and live Demo session. Test logs are under `/tmp/flawk-persistent-deploy`; these are temporary, not durable backups. No deployment credentials are included in this document.
