/* USB CDC-ACM serial: PC output for the master role + host-triggered bootloader
 * entry (1200-baud touch). */
#ifndef USB_H
#define USB_H

#ifdef __cplusplus
extern "C" {
#endif

/* Bring up nRF USB power events + TinyUSB. Call once after board_init(). */
void usb_init(void);

/* Pump the TinyUSB device stack. Call frequently from the main loop. */
void usb_task(void);

/* Best-effort write of a NUL-terminated string to the CDC port (dropped if no
 * host is attached). */
void usb_write(const char *s);

/* Read one byte from the CDC port; returns the byte (0-255) or -1 if none. */
int usb_read_byte(void);

/* Non-zero when a host has opened the CDC port (DTR asserted). */
int usb_connected(void);

#ifdef __cplusplus
}
#endif

#endif /* USB_H */
