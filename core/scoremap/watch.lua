-- Scoremap discovery helper (T32b, docs/contracts/scoremap.md).
--
-- Run MAME with your normal window, plus this script, while you play and score:
--
--   ./mame/gridlee gridlee -rompath roms -cheat \
--       -autoboot_script core/scoremap/watch.lua
--
-- It appends one line per emulated second to $WMA_WATCH_LOG (default
-- /tmp/gridlee_ram.log): "RAM <frame> <hex bytes 0x0000..0x07ff>". Play for a
-- minute, scoring a few known amounts, then quit. The score cell is the one
-- whose value tracks the on-screen score; decode it per docs/contracts/scoremap.md.
--
-- Reading uses `read_direct_u8` (a side-effect-free RAM read), so logging never
-- disturbs the game.

local out = os.getenv("WMA_WATCH_LOG") or "/tmp/gridlee_ram.log"
print("WMA scoremap watch: appending program RAM to " .. out)

local m = manager.machine
local cpu = m.devices[":maincpu"]
local prog = cpu.spaces["program"]
local f = io.open(out, "a")
local n = 0

emu.register_frame_done(function()
	n = n + 1
	if n % 60 == 0 then
		local t = {}
		for a = 0x00, 0x7ff do
			t[#t + 1] = string.format("%02x", prog:read_direct_u8(a) & 0xff)
		end
		f:write("RAM " .. n .. " " .. table.concat(t) .. "\n")
		f:flush()
	end
end)
