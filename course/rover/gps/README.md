# FSK GPS-Registration Unit

A lightweight **Raspberry Pi Zero 2 W + ZED-F9P** stand-in for the full
[rover](../README.md), built for one job: **surveying cone coordinates**
with RTK precision. Carry it to a cone, hit "좌표 요청" in the course UI,
and it answers with the current RTK fix. No motors, no MCU, no autonomous
driving — just GPS → server.

## Why this exists (and how it differs from the rover)

The full rover is a Raspberry Pi 5 running **AlmaLinux 10 bootc** with the
ROS 2 Jazzy pilot in a podman container. That stack does **not** fit on a
Zero 2 W:

- AlmaLinux's `bootc-images-rpi` supports only Pi 4 / Pi 5 (GPT/UEFI boot)
  — the Pi-3-class Zero 2 W isn't a supported board.
- 512 MB RAM can't host AlmaLinux + podman + ROS 2 Jazzy.

So this unit runs **Raspberry Pi OS Lite (64-bit, Trixie)**, configured
headless via **cloud-init**, with the agent as a plain `systemd` Python
service — no ROS, no container. It still reuses the rover's proven,
ROS-free GPS/NTRIP code (see [Code reuse](#code-reuse)).

> **One rover slot.** The course server tracks a single rover connection.
> Run **either** the full rover **or** this GPS unit against a given server
> at a time — both authenticate with the same `INTERNAL_SECRET` and would
> otherwise kick each other off the SSE stream.

## Hardware

| Role | Part | Interface |
|------|------|-----------|
| Compute | Raspberry Pi Zero 2 W (512 MB) | — |
| GPS | u-blox ZED-F9P | USB CDC (`/dev/ttyGPS`) |
| RTK corrections | NTRIP caster (NGII) | TCP |

## Architecture

One process (`gps_register.py`), four threads, `--network=host` style direct
HTTP to the course server (port 10000):

```
                course server  (/course)
                      ▲  │
   POST position/     │  │  SSE /api/rover/stream
   telemetry          │  ▼     └─ request-position ─┐
                 ┌────┴──────────────────────────┐  │
                 │        gps_register.py         │◄─┘
                 │  serial loop · ntrip · sse ·   │
                 │  telemetry · post worker       │
                 └────┬───────────────────────────┘
                      │ UBX  ▲ RTCM3
                      ▼      │
                   ZED-F9P (USB /dev/ttyGPS)
```

- **serial loop** — opens `/dev/ttyGPS`, configures the F9P (UBX
  NAV-PVT/HPPOSLLH/DOP on, NMEA off), parses fixes, reopens on USB drop,
  and POSTs position every `POSITION_REPORT_INTERVAL` s.
- **ntrip** — on the first 3D fix, fetches the NGII source table, picks the
  nearest RTCM 3.2 base, and streams corrections back into the receiver.
- **sse** — holds `/api/rover/stream`; on `request-position` replies with
  the current fix tagged with the request id. Other rover commands
  (execute-path, manual-control, calibrate-\*) are no-ops here.
- **telemetry** — every 3 s POSTs `fix_status`, NTRIP status, and GPS
  accuracy so the operator UI shows live RTK quality. `nav_state` is always
  `IDLE`.

## Server endpoints used

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `GET /api/rover/stream` | unit → server (SSE) | receive `request-position` |
| `POST /api/rover/position` | unit → server | live marker + request replies |
| `POST /api/rover/telemetry` | unit → server | fix status / RTK quality |

All three are internal-strict — the unit sends `X-Internal-Service:
$INTERNAL_SECRET`.

## Provisioning

### 1. Flash the SD card (one-time, headless via cloud-init)

Flash **Raspberry Pi OS Lite 64-bit** and drop cloud-init config in the boot
partition (`user-data` + `network-config`). The current card is set up with:

| | |
|---|---|
| hostname | `fsk-rover-gps` (`fsk-rover-gps.local` via mDNS) |
| user | `fsk`, SSH key-only (`github.com/luftaquila.keys`), NOPASSWD sudo |
| Wi-Fi | SSID `fsk-rover`, regulatory-domain `KR` (PSK on the card, not in git) |
| Tailscale | installed + `tailscale up` on first boot (machine `fsk-rover-gps`); auto-reconnects every boot after |

The Wi-Fi PSK and the Tailscale auth key live **only on the SD card's
cloud-init** (`network-config` / `user-data` `runcmd`), never in git — same
posture as the rover's placeholder `fsk-default.nmconnection`. Boot needs
internet on the team Wi-Fi the first time so Tailscale can install + auth.

Boot, wait ~1–2 min for first-boot setup, then `ssh fsk@fsk-rover-gps.local`
(or via Tailscale). Re-point Wi-Fi for a site with:

```bash
sudo nmcli connection modify <conn> 802-11-wireless.ssid 'MyAP' \
    wifi-sec.psk 'mypassword' && sudo nmcli connection up <conn>
```

### 2. Deploy the agent + secrets + Tailscale

From the admin machine (reads `INTERNAL_SECRET`, `PUBLIC_URL` from `.env`):

```bash
scripts/provision-gps.sh fsk-rover-gps.local \
    --ntrip-username=<NGII login> \
    --tailscale-authkey=tskey-…        # optional fallback; first boot already
                                       # brings Tailscale up via cloud-init
```

Idempotent — it deploys `/opt/gps-register`, apt-installs
`python3-serial`/`python3-requests` + Tailscale, writes
`/etc/gps-register/gps.conf` (0600), installs the udev rule + systemd unit,
and starts `gps-register.service`. Tailscale is normally already up from the
first-boot cloud-init; `--tailscale-authkey` is only needed to (re-)auth if
that failed (e.g. no internet on first boot).

### 3. Verify

```bash
ssh fsk@fsk-rover-gps.local systemctl status gps-register.service
ssh fsk@fsk-rover-gps.local sudo journalctl -u gps-register.service -f
```

## Runtime configuration

`/etc/gps-register/gps.conf` (sourced by the systemd unit as `EnvironmentFile`):

| Var | Meaning |
|-----|---------|
| `SERVER_URL` | course server base, e.g. `https://host/course` (https enforced) |
| `INTERNAL_SECRET` | `X-Internal-Service` header |
| `NTRIP_USERNAME` | NGII login; unset ⇒ run **without** RTK |
| `GPS_SERIAL_PORT` | default `/dev/ttyGPS` |
| `GPS_BAUD` | default `115200` |
| `GPS_MEAS_RATE_MS` | receiver fix period, default `1000` (1 Hz) |
| `POSITION_REPORT_INTERVAL` | seconds between position POSTs, default `1.0` |
| `SERVER_URL_ALLOW_HTTP` | `true` to allow `http://` (trusted Tailscale only) |

After editing: `sudo systemctl restart gps-register.service`.

Fixed NTRIP settings (NGII) match the rover: `www.gnssdata.or.kr:2101`,
password `gnss`, mountpoint auto-selected (nearest RTCM 3.2 base).

## Code reuse

The agent imports the rover's pure, ROS-free modules directly — single
source of truth, no vendored copies in git:

| Module | From |
|--------|------|
| `pilot.lib.ubx_parser` | UBX NAV-PVT/HPPOSLLH/DOP parsing + CFG-VALSET |
| `pilot.lib.ntrip_client` | NTRIP v2 client, source-table, nearest-mount |
| `pilot.lib.geo_utils` | haversine (used by ntrip_client) |
| `pilot.lib.protocol_utils` | `assemble_sse_data` |

`gps_register.py` adds the pilot package root to `sys.path` (handling both
the in-repo tree and the `/opt/gps-register` deploy layout).
`provision-gps.sh` copies these four files alongside the agent at deploy
time.

## Tests

```bash
cd course/rover/gps
python3 -m pytest test/ -q     # pure logic: fix status, telemetry, SSE parse
```

CI: `.github/workflows/rover-gps.yml` (push to `main` under `gps/**`).

## Recovery

Unreachable (no LAN, no Tailscale) → reflash SD (see step 1) and re-run
`provision-gps.sh`.
