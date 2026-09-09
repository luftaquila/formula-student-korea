# FSK GPS-Registration Unit

A Raspberry Pi Zero 2 W + ZED-F9P unit for RTK cone surveys. At a cone, press
"좌표 요청" in the course UI to capture the current fix. It can also supply RTCM3
corrections as a [fixed base station](#base-station).

## Why this exists (and how it differs from the rover)

The Zero 2 W is unsupported by the rover's Pi 4/5 GPT/UEFI bootc image, and its
512 MB RAM cannot host AlmaLinux, podman, and ROS 2 Jazzy. It runs Raspberry Pi OS
Lite (64-bit, Trixie), provisioned headlessly with cloud-init, and a Python systemd
service using the rover's [ROS-free GPS/NTRIP modules](#code-reuse).

The receiver uses `?device=gps`, independently of the rover slot. Both authenticate
with `INTERNAL_SECRET` and may connect simultaneously. Cone capture prefers the
receiver, falling back to the rover.

## Hardware

| Role | Part | Interface |
|------|------|-----------|
| Compute | Raspberry Pi Zero 2 W (512 MB) | — |
| GPS | u-blox ZED-F9P | USB CDC (`/dev/ttyGPS`) |
| RTK corrections | NTRIP caster (NGII) | TCP |

## Architecture

`gps_register.py` communicates directly with the Course server (port 10000):

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
- **sse** — holds `/api/rover/stream?device=gps`; on `request-position` replies
  with the current fix tagged with the request id, and handles the base-station
  commands (`base-survey-start`/`base-survey-cancel`/`base-activate`/`base-stop`).
  Other rover commands (execute-path, manual-control, calibrate-\*) are no-ops.
- **telemetry** — every 3 s POSTs `fix_status`, NTRIP status, GPS accuracy,
  plus `mode`/`base` (base-session state + relayed RTCM bytes) so the operator
  UI shows live RTK quality. `nav_state` is always `IDLE`.

## Server endpoints used

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `GET /api/rover/stream?device=gps` | unit → server (SSE) | commands (request-position, base-\*) |
| `POST /api/rover/position?device=gps` | unit → server | live marker + request replies |
| `POST /api/rover/telemetry?device=gps` | unit → server | fix status / RTK quality / base state |
| `POST /api/rover/base/survey-result` | unit → server | surveyed base coordinate |
| `POST /api/rover/base/rtcm` | unit → server | RTCM3 chunks (relayed to the rover) |

All are internal-strict — the unit sends `X-Internal-Service: $INTERNAL_SECRET`.

## Base station

Managed from the course UI's **GPS** tab (admin). Two steps:

1. **Survey** a named point (`측량`): while NGII RTK is `rtk_fixed`, the unit
   averages `NAV-HPPOSLLH` positions for the chosen duration (default 120 s) and
   records the mean as the point's coordinate (`POST /api/rover/base/survey-result`).
2. **Activate** it as the base (select **수신기 base station** + the point): the
   server sends `base-activate`, the unit switches the F9P to **TMODE FIXED (LLH)**
   at the surveyed coordinate and enables RTCM3 (MSM7 1077/1087/1097/1127 + 1005 +
   1230) on USB. It extracts complete RTCM3 frames from the serial stream (see
   `pilot/lib/rtcm_utils.py`) and relays them via `POST /api/rover/base/rtcm`; the
   server forwards them to the rover over its SSE (`rtcm` event → GPS serial). No
   NGII needed while acting as a fixed base.

Cone-capture and base-station roles are mutually exclusive (`_mode`): in base mode
the unit is not a position source, so cone capture falls back to the rover (which
is now getting RTK from this base). Switching the source back to **NGII** sends
`base-stop`, reverts TMODE, and resumes normal capture.

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

Keep Wi-Fi and Tailscale keys only in the card's cloud-init files
(`network-config` and `user-data`), never in Git. First boot needs internet to
install and authenticate Tailscale.

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

The idempotent script deploys `/opt/gps-register`, installs `python3-serial`,
`python3-requests`, Tailscale, udev rules, and the systemd unit, writes
`/etc/gps-register/gps.conf` (0600), and starts `gps-register.service`.
Use `--tailscale-authkey` only if cloud-init authentication failed or re-auth is needed.

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

The agent imports ROS-free pilot modules without vendored copies:

| Module | From |
|--------|------|
| `pilot.lib.ubx_parser` | UBX NAV-PVT/HPPOSLLH/DOP parsing + CFG-VALSET |
| `pilot.lib.ntrip_client` | NTRIP v2 client, source-table, nearest-mount |
| `pilot.lib.geo_utils` | haversine (used by ntrip_client) |
| `pilot.lib.protocol_utils` | `assemble_sse_data` |
| `pilot.lib.rtcm_utils` | RTCM3 framer + CRC-24Q (base-station output) |

`gps_register.py` adds the pilot package root to `sys.path` (handling both
the in-repo tree and the `/opt/gps-register` deploy layout).
`provision-gps.sh` copies these files alongside the agent at deploy time.

## Tests

```bash
cd rover/gps
python3 -m pytest test/ -q     # pure logic: fix status, telemetry, SSE parse
```

CI: the `gps` job in `.github/workflows/rover.yml` (push to `main` under
`gps/**` or changes to the Pilot libraries reused by GPS).

## Recovery

Unreachable (no LAN, no Tailscale) → reflash SD (see step 1) and re-run
`provision-gps.sh`.
