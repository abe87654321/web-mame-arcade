// license:BSD-3-Clause
// copyright-holders:Web MAME Arcade
/***************************************************************************

    netplay.h

    Delay-based lockstep hook for the Web MAME Arcade browser core (T20).
    The C ABI below is consumed by scripts/resources/emscripten/netplay_post.js
    and, through it, by the typed wrapper in packages/web/src/core/.

***************************************************************************/

#ifndef MAME_EMU_NETPLAY_H
#define MAME_EMU_NETPLAY_H

#pragma once

#include <cstdint>

class running_machine;

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#define NETPLAY_API extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define NETPLAY_API extern "C"
#endif

// C ABI exported to JavaScript. Identical numbers on every peer (docs/02).
NETPLAY_API void     netplay_enable(void);
NETPLAY_API void     netplay_set_inputs(uint32_t frame, uint16_t p1, uint16_t p2, uint16_t p3, uint16_t p4);
NETPLAY_API int      netplay_ready(uint32_t frame);
NETPLAY_API void     netplay_step(uint32_t frame);
NETPLAY_API int      netplay_state_size(void);
NETPLAY_API int      netplay_save_state(uint8_t *buf);
NETPLAY_API int      netplay_load_state(const uint8_t *buf);
NETPLAY_API uint32_t netplay_hash(void);

// Internal hooks used by the patched emulation core (machine.cpp, ioport.cpp).
bool netplay_input_active();
uint32_t netplay_next_frame();
bool netplay_try_run_frame(running_machine &machine, uint32_t frame);

#endif // MAME_EMU_NETPLAY_H
