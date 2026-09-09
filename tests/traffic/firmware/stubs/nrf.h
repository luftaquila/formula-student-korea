#ifndef AUDIT_NRF_H
#define AUDIT_NRF_H
#include <stdint.h>
typedef struct {uint32_t HFCLKSTAT,EVENTS_HFCLKSTARTED,TASKS_HFCLKSTART;} clock_mock_t;
typedef struct {uint32_t TASKS_STOP,MODE,BITMODE,PRESCALER,TASKS_CLEAR,TASKS_START,TASKS_CAPTURE[4],CC[4];} timer_mock_t;
typedef struct {uint32_t VTOR;} scb_mock_t;
static clock_mock_t clock_mock;
static timer_mock_t timer_mock;
static scb_mock_t scb_mock;
#define NRF_CLOCK (&clock_mock)
#define NRF_TIMER2 (&timer_mock)
#define SCB (&scb_mock)
#define CLOCK_HFCLKSTAT_STATE_Msk 1u
#define CLOCK_HFCLKSTAT_SRC_Msk 2u
#define CLOCK_HFCLKSTAT_SRC_Pos 1u
#define CLOCK_HFCLKSTAT_SRC_Xtal 1u
#define TIMER_MODE_MODE_Timer 0u
#define TIMER_BITMODE_BITMODE_32Bit 3u
#endif
