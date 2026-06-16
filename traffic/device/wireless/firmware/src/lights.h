/* Traffic-light SSR outputs (master role) — DESIGN.md §6.4.
 *
 * Each colour drives a high-side 2-BJT stage: GPIO HIGH -> NPN on -> PNP on ->
 * +12V onto the RD/GN line at J_LIGHT, which switches an external SSR (and thus
 * the AC lamp). The light is red XOR green, never both.
 */
#ifndef LIGHTS_H
#define LIGHTS_H

typedef enum {
    LIGHTS_OFF,
    LIGHTS_RED,
    LIGHTS_GREEN,
} light_state_t;

void lights_init(void);
void lights_set(light_state_t state);

#endif /* LIGHTS_H */
