# FSK GPS-Registration Unit

Pi Zero 2 W + ZED-F9P supports position capture or a mutually exclusive
[RTCM3 base-station mode](#base-station).

## Runtime choice

The 512 MB Zero 2 W uses Raspberry Pi OS Lite (64-bit, Trixie), cloud-init, and a
Python systemd service. It cannot use the Pi 4/5 bootc image or the full ROS stack.
The agent shares the rover's [ROS-free GPS/NTRIP code](#code-reuse).

Its independent `?device=gps` slot authenticates with `INTERNAL_SECRET` and can
coexist with the rover. Cone capture prefers the receiver.

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

The agent configures UBX NAV-PVT/HPPOSLLH/DOP with NMEA off, reopens dropped USB,
and reports position at `POSITION_REPORT_INTERVAL`. The first 3D fix selects the
nearest NGII RTCM 3.2 base. SSE handles position requests and base commands;
driving/calibration commands are ignored. Telemetry every 3 s includes fix/NTRIP
quality and base state, with `nav_state=IDLE`.

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

- Survey requires NGII `rtk_fixed`; average `NAV-HPPOSLLH` over the requested
  duration (default 120 s), then POST `/api/rover/base/survey-result`.
- `base-activate` switches F9P to TMODE FIXED (LLH), enables USB RTCM3
  MSM7 1077/1087/1097/1127 + 1005 + 1230, and relays complete frames through
  `/api/rover/base/rtcm`. The server forwards them to the rover's `rtcm` SSE.
- Base mode disables receiver position capture and NGII corrections; capture
  falls back to the rover. `base-stop` reverts TMODE and restores capture.

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

After first-boot setup, connect with `ssh fsk@fsk-rover-gps.local` or Tailscale.
Update Wi-Fi with:

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
