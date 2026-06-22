/* Board pin map — verbatim from traffic/DESIGN.md §4 (정본).
 *
 * SuperMini nRF52840 GPIO numbering: P0.n == n, P1.n == 32 + n.
 * PIN(port, n) matches Nordic's NRF_GPIO_PIN_MAP(port, n).
 *
 * Single board, role chosen by firmware (node_id): master drives the lights
 * over the SSR outputs and talks to the PC over USB; sensor captures events and
 * reports over LoRa. Capture pins (DIO1, SENSOR) are on port 1 — GPIOTE PSEL
 * must include the port bit (handled in the capture module, Stage 3).
 */
#ifndef CONFIG_H
#define CONFIG_H

#define PIN(port, n) ((port) * 32 + (n))

/* Status — onboard LED. Polarity unverified (DESIGN.md §10 open item); blink is
 * polarity-agnostic. */
#define PIN_LED_STATUS PIN(0, 15)

/* LoRa radio (Ra-01SH / SX1262) — SPIM + control */
#define PIN_LORA_SCK   PIN(0, 22)
#define PIN_LORA_MISO  PIN(0, 20)
#define PIN_LORA_MOSI  PIN(0, 17)
#define PIN_LORA_NSS   PIN(0, 8)
#define PIN_LORA_BUSY  PIN(1, 0)
#define PIN_LORA_DIO1  PIN(1, 6)  /* GPIOTE capture (Tx/RxDone) — port 1 */
#define PIN_LORA_NRST  PIN(0, 11) /* radio reset (NOT the board RST pin) */
#define PIN_LORA_TXEN  PIN(1, 4)  /* RF switch TX enable */
#define PIN_LORA_RXEN  PIN(0, 24) /* RF switch RX enable */

/* Sensor input (BA2M NPN open-collector, falling edge) — sensor role */
#define PIN_SENSOR_IN  PIN(1, 11) /* GPIOTE capture (falling) — port 1 */

/* Traffic light SSR drive (high-side 2-BJT per colour) — master role */
#define PIN_LIGHT_RED   PIN(0, 29)
#define PIN_LIGHT_GREEN PIN(0, 2)

/* VCC enable gate — must be driven HIGH at boot (DESIGN.md §8) */
#define PIN_EXT_POWER  PIN(0, 13)

/* LoRa radio parameters — DESIGN.md §2.1/§2.2 (KR920). One master + up to 6
 * sensors share this ONE channel; collisions are handled in the MAC, not by
 * channel separation. Bring-up tunables. */
#define LORA_FREQ_MHZ   921.3f
#define LORA_BW_KHZ     250.0f  /* SF7/BW250, symbol 512us */
#define LORA_SF         7
#define LORA_CR         5       /* coding rate 4/5 */
#define LORA_SYNCWORD   0x12
#define LORA_POWER_DBM  12      /* conducted ~+12dBm -> EIRP <= +14dBm with ~2dBi */
#define LORA_PREAMBLE   8
#define LORA_TCXO_V     1.6f    /* Ra-01SH TCXO via DIO3; if begin() fails XOSC, try 1.8/3.0 */

/* Fixed TxDone->RxDone air delay in 16 MHz ticks (DESIGN §2.9 T_air_ref).
 * Bias-only constant: it cancels for sensor-to-sensor splits (both biased
 * equally) and only shifts green-to-sensor (launch) timing. Measure once on a
 * scope (master DIO1 TxDone edge -> sensor DIO1 RxDone edge at close range);
 * 0 is acceptable for split timing. Will move to the per-set ID_SETUP table. */
#define T_AIR_REF_TICKS 0u

/* Channel-access timing on the one shared channel (DESIGN §2.8). The beacon at
 * the top of each 1 s frame is the sync anchor; each sensor sends its periodic
 * STATUS in a node-keyed TDMA slot measured from its beacon RxDone, so STATUS
 * uplinks never collide. Asynchronous EVENTs use CAD + ACK + backoff in the rest
 * of the frame. AEAD sealing (DESIGN §2.11) adds 26 B/packet (10 B header +
 * 16 B tag); the largest packet (sealed STATUS, 47 B) is ~46 ms on air at
 * SF7/BW250/CR4-5 vs the ~31 ms of the old plaintext format. Slots/base widened
 * to keep margin for that plus clock error (<40 us/s) and Rx/Tx turnaround.
 * 6 sensors fit easily: 80 + 6*90 = 620 ms of the 1 s frame. */
#define SLOT_WIDTH_MS   90u  /* per-node STATUS slot width (sealed STATUS ~46 ms + guard) */
#define STATUS_GUARD_MS 10u  /* sensor waits this long into its slot before TX */
#define TDMA_BASE_MS    80u  /* first slot starts here (sealed beacon ~41 ms drains) */
#define STATUS_PERIOD_S 5u   /* a node sends STATUS once per this many beacons (= 5 s) */

/* EVENT freshness gate (DESIGN §2.11), a defence-in-depth backstop to the
 * master-session binding (event names the master boot_id) and the per-sensor
 * replay counter. An EVENT carries an absolute master-time tick; the master
 * rejects one whose timestamp is too old (stale replay within a session) or
 * implausibly in the future. The window is asymmetric: a real event is at most a
 * few ms in the future (sensor sync error), but can be a few s in the past if
 * the link was momentarily congested, so the past bound is generous and the
 * future bound is tight. */
#define EVENT_FRESH_MS  3000u /* max age (past) accepted */
#define EVENT_FUTURE_MS 250u  /* max future skew accepted (sync error headroom) */

/* W5 Schottky drop between the cell and VDDH (DESIGN: BAT60B ~0.24 V; some boards
 * ship a silicon diode ~0.7 V). Added back to the sensor's measured VDDH to
 * estimate cell voltage. Master reports raw VDDH (charge rail), so it skips this. */
#define BATT_DIODE_DROP_MV 240u

#endif /* CONFIG_H */
