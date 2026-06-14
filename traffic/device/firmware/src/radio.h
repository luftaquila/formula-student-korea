/* C-callable LoRa radio bring-up API (wraps the C++ RadioLib SX1262). */
#ifndef RADIO_H
#define RADIO_H

#ifdef __cplusplus
extern "C" {
#endif

/* Initialise the SX1262 on the given frequency (MHz) with the DESIGN §2
 * parameters. Returns 0 on success, else the (negative) RadioLib error code. */
int radio_begin(float freq_mhz);

#include <stdint.h>

/* Blocking transmit of len bytes. Returns 0 on success. */
int radio_transmit(const uint8_t *data, int len);

/* Put the radio into continuous receive. Returns 0 on success. */
int radio_start_rx(void);

/* Non-blocking RX poll: >0 = bytes read into buf (and re-armed), 0 = nothing
 * yet, <0 = receive error. */
int radio_receive(uint8_t *buf, int maxlen);

/* Same as radio_receive, but also returns the last packet's link quality
 * (RSSI dBm, SNR dB) sampled before the radio is re-armed. Used by the master
 * for per-sensor diagnostics. The rssi/snr outputs are only meaningful when the
 * return value is > 0. */
int radio_receive_q(uint8_t *buf, int maxlen, float *rssi, float *snr);

/* Channel Activity Detection: non-zero if LoRa activity is present (listen
 * before talk, DESIGN §2.8). */
int radio_channel_busy(void);

#ifdef __cplusplus
}
#endif

#endif /* RADIO_H */
