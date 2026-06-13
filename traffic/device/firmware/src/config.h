/* Board pin map — verbatim from traffic/device/DESIGN.md §4 (정본).
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

/* LoRa radio parameters — DESIGN.md §2.1/§2.2 (KR920, set A). Bring-up tunables. */
#define LORA_FREQ_MHZ   921.3f  /* set A; B=922.1, C=922.9 */
#define LORA_BW_KHZ     250.0f  /* SF7/BW250, symbol 512us */
#define LORA_SF         7
#define LORA_CR         5       /* coding rate 4/5 */
#define LORA_SYNCWORD   0x12
#define LORA_POWER_DBM  12      /* conducted ~+12dBm -> EIRP <= +14dBm with ~2dBi */
#define LORA_PREAMBLE   8
#define LORA_TCXO_V     1.6f    /* Ra-01SH TCXO via DIO3; if begin() fails XOSC, try 1.8/3.0 */

/* Fixed TxDone->RxDone air delay in 16 MHz ticks (DESIGN §2.9 T_air_ref).
 * Placeholder 0 until measured — only shifts the absolute offset, not its
 * stability, so it does not affect the Stage-3b sync verification. */
#define T_AIR_REF_TICKS 0u

#endif /* CONFIG_H */
