/* C-callable LoRa radio bring-up API (wraps the C++ RadioLib SX1262). */
#ifndef RADIO_H
#define RADIO_H

#ifdef __cplusplus
extern "C" {
#endif

/* Initialise the SX1262 with the DESIGN §2 parameters. Returns 0 on success,
 * else the (negative) RadioLib error code. */
int radio_begin(void);

/* Blocking transmit of a fixed bring-up beacon. Returns 0 on success. */
int radio_transmit_beacon(void);

/* Put the radio into continuous receive. Returns 0 on success. */
int radio_start_rx(void);

/* Non-blocking RX poll: 1 = a clean packet was received (and re-armed),
 * 0 = nothing yet, <0 = receive error. */
int radio_poll_rx(void);

#ifdef __cplusplus
}
#endif

#endif /* RADIO_H */
