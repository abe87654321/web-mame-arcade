// license:BSD-3-Clause
// copyright-holders:Web MAME Arcade
/***************************************************************************

    netplay.cpp

    Minimal delay-based lockstep core for the browser build (T20):
    - one frame is stepped only when every player's input for it is present;
    - inputs are injected into ioport fields, never read from the local OSD;
    - state save/load goes through save_manager's in-memory buffer;
    - netplay_hash() is a CRC32 of the full registered machine state (the
      save_manager buffer), a fully-initialised superset of main RAM.

    The emulation path must stay byte-identical on every peer: no wall clock,
    no random, no locale. The game frame period comes from the screen device.

***************************************************************************/

#include "emu.h"
#include "screen.h"

#include "netplay.h"

#include <array>
#include <map>
#include <vector>

namespace {

// Active player masks for a frame, indexed 0..3.
using frame_inputs = std::array<uint16_t, 4>;

// Bound ioport fields per [player][bit]; bits 0-11 are defined by the wire
// contract (docs/contracts/input-packet.md), 12-15 reserved.
using field_table = std::array<std::array<std::vector<ioport_field *>, 12>, 4>;

bool s_active = false;
uint32_t s_next_frame = 0;
std::map<uint32_t, frame_inputs> s_pending;
field_table s_fields;

// Cap how far ahead of the step clock inputs may be buffered. Bounding by frame
// distance (not by entry count) keeps the refusal identical on every peer: an
// arrival-order-dependent count bound could refuse different frames on
// different peers and deadlock the lockstep.
constexpr uint32_t MAX_FRAME_LOOKAHEAD = 256;

running_machine *current_machine()
{
#if defined(__EMSCRIPTEN__)
	return running_machine::emscripten_get_running_machine();
#else
	return nullptr;
#endif
}

// Map an ioport field to its wire bit, or -1 if it is not a player control.
int bit_for_field(ioport_field &field)
{
	int const player = field.player();
	if (player < 0 || player > 3)
		return -1;
	switch (field.type())
	{
	case IPT_JOYSTICK_UP:    return 0;
	case IPT_JOYSTICK_DOWN:  return 1;
	case IPT_JOYSTICK_LEFT:  return 2;
	case IPT_JOYSTICK_RIGHT: return 3;
	case IPT_BUTTON1:        return 4;
	case IPT_BUTTON2:        return 5;
	case IPT_BUTTON3:        return 6;
	case IPT_BUTTON4:        return 7;
	case IPT_BUTTON5:        return 8;
	case IPT_BUTTON6:        return 9;
	default: break;
	}
	// Start/coin slots are numbered per player (IPT_START1..4 / IPT_COIN1..4).
	if (field.type() == ioport_type(IPT_START1 + player))
		return 10;
	if (field.type() == ioport_type(IPT_COIN1 + player))
		return 11;
	return -1;
}

void build_bindings(running_machine &machine)
{
	for (auto &slot : s_fields)
		for (auto &bits : slot)
			bits.clear();

	for (auto const &port : machine.ioport().ports())
	{
		simple_list<ioport_field> &fields =
				const_cast<simple_list<ioport_field> &>(port.second->fields());
		for (ioport_field &field : fields)
		{
			int const bit = bit_for_field(field);
			if (bit >= 0)
				s_fields[field.player()][bit].push_back(&field);
		}
	}
}

void inject(frame_inputs const &inputs)
{
	for (int player = 0; player < 4; ++player)
	{
		uint16_t const mask = inputs[player];
		for (int bit = 0; bit < 12; ++bit)
		{
			ioport_value const value = (mask >> bit) & 1;
			for (ioport_field *field : s_fields[player][bit])
				field->set_value(value);
		}
	}
}

attotime frame_period(running_machine &machine)
{
	screen_device *screen = screen_device_enumerator(machine.root_device()).first();
	if (screen != nullptr)
		return screen->frame_period();
	return attotime(0, HZ_TO_ATTOSECONDS(60));
}

} // anonymous namespace


//-------------------------------------------------
//  netplay_input_active - true once netplay owns
//  the frame clock and reader thread input source
//-------------------------------------------------

bool netplay_input_active()
{
	return s_active;
}


//-------------------------------------------------
//  netplay_next_frame - frame the rAF loop should
//  attempt next
//-------------------------------------------------

uint32_t netplay_next_frame()
{
	return s_next_frame;
}


//-------------------------------------------------
//  netplay_enable - bind ioport fields once and
//  take over input; idempotent
//-------------------------------------------------

void netplay_enable()
{
	running_machine *machine = current_machine();
	if (machine == nullptr || s_active)
		return;
	build_bindings(*machine);
	s_active = true;
	s_next_frame = 0;
}


//-------------------------------------------------
//  netplay_set_inputs - record one frame's masks
//-------------------------------------------------

void netplay_set_inputs(uint32_t frame, uint16_t p1, uint16_t p2, uint16_t p3, uint16_t p4)
{
	netplay_enable();

	// The wire protocol repeats the last 8 frames; a duplicate for the same
	// frame must not let arrival order pick the effective input, and a frame the
	// clock has already stepped must be ignored.
	if (frame < s_next_frame || s_pending.find(frame) != s_pending.end())
		return;
	// Far ahead of the step clock: refuse rather than silently evict a frame the
	// gate still needs (a stall is visible; an eviction is a silent desync). The
	// distance bound is frame-based, so every peer refuses the same frames.
	if (frame > s_next_frame + MAX_FRAME_LOOKAHEAD)
		return;

	s_pending[frame] = frame_inputs{ p1, p2, p3, p4 };
}


//-------------------------------------------------
//  netplay_ready - every player's input present?
//-------------------------------------------------

int netplay_ready(uint32_t frame)
{
	return s_pending.find(frame) != s_pending.end() ? 1 : 0;
}


//-------------------------------------------------
//  netplay_try_run_frame - the frame gate: step one
//  real screen frame iff its inputs are present
//-------------------------------------------------

bool netplay_try_run_frame(running_machine &machine, uint32_t frame)
{
	auto pending = s_pending.find(frame);
	if (pending == s_pending.end())
		return false;

	frame_inputs const inputs = pending->second;
	s_pending.erase(pending);

	inject(inputs);

	device_scheduler &scheduler = machine.scheduler();
	attotime const stoptime = scheduler.time() + frame_period(machine);
	while (!machine.paused() && !machine.scheduled_event_pending() && scheduler.time() < stoptime)
		scheduler.timeslice();

	s_next_frame = frame + 1;
	return true;
}


//-------------------------------------------------
//  netplay_step - JS-driven single frame
//-------------------------------------------------

void netplay_step(uint32_t frame)
{
	running_machine *machine = current_machine();
	if (machine != nullptr)
		netplay_try_run_frame(*machine, frame);
}


//-------------------------------------------------
//  netplay_state_size - bytes needed by save/load
//-------------------------------------------------

int netplay_state_size()
{
	running_machine *machine = current_machine();
	if (machine == nullptr)
		return 0;
	return int(machine->save().buffer_size());
}


//-------------------------------------------------
//  netplay_save_state - snapshot into a JS buffer
//-------------------------------------------------

int netplay_save_state(uint8_t *buf)
{
	running_machine *machine = current_machine();
	if (machine == nullptr || buf == nullptr)
		return 0;
	return machine->save().write_buffer(buf, machine->save().buffer_size()) == STATERR_NONE ? 1 : 0;
}


//-------------------------------------------------
//  netplay_load_state - restore a JS buffer
//-------------------------------------------------

int netplay_load_state(uint8_t const *buf)
{
	running_machine *machine = current_machine();
	if (machine == nullptr || buf == nullptr)
		return 0;
	return machine->save().read_buffer(buf, machine->save().buffer_size()) == STATERR_NONE ? 1 : 0;
}


//-------------------------------------------------
//  netplay_hash - CRC32 over the full registered
//  machine state (save_manager buffer)
//
//  A superset of main RAM that is guaranteed fully initialised; hashing the
//  raw memory regions instead would include uninitialised bytes from large
//  ROM regions and diverge across peers. Identical core build => identical
//  state => identical hash.
//-------------------------------------------------

uint32_t netplay_hash()
{
	running_machine *machine = current_machine();
	if (machine == nullptr)
		return 0;

	save_manager &save = machine->save();
	size_t const size = save.buffer_size();
	if (size == 0)
		return 0;

	std::vector<uint8_t> buffer(size);
	if (save.write_buffer(buffer.data(), size) != STATERR_NONE)
		return 0;

	return uint32_t(util::crc32_creator::simple(buffer.data(), uint32_t(size)));
}
