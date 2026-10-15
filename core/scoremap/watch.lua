-- Scoremap discovery helper (T32b, T47; docs/contracts/scoremap.md).
--
-- Run MAME with your normal window, plus this script, while you play and score:
--
--   ./mame/gridlee gridlee -rompath roms -cheat \
--       -autoboot_script core/scoremap/watch.lua
--
-- One line per emulated second is appended to $WMA_WATCH_LOG (default
-- /tmp/wma_watch_ram.log): "RAM <frame> <hex bytes>". Play for a minute,
-- scoring a few known amounts, then quit. The score cell is the one whose value
-- tracks the on-screen score; decode it per docs/contracts/scoremap.md.
--
-- The memory window is configurable so this helper works for any driver (T47),
-- not just gridlee. Addresses accept 0x-prefixed hex or plain decimal:
--   WMA_WATCH_CPU     CPU device tag        (default ":maincpu")
--   WMA_WATCH_SPACE   address space         (default "program")
--   WMA_WATCH_START   first byte address    (default 0x00)
--   WMA_WATCH_END     last byte address     (default 0x7ff)
--   WMA_WATCH_STRIDE  sample every Nth byte (default 1; bounds line length)
--   WMA_WATCH_LOG     output file           (default /tmp/wma_watch_ram.log)
--
-- Reading uses `read_direct_u8` (a side-effect-free RAM read), so logging never
-- disturbs the game. A byte with no direct pointer (handler-mapped memory) is
-- logged as `ff` rather than switching to a side-effecting read.

local function parse_addr(value, default)
	if value == nil or value == "" then return default end
	local hex = value:match("^0[xX](%x+)$")
	if hex then return tonumber(hex, 16) end
	local dec = tonumber(value)
	if dec == nil then return default end
	return dec
end

local cpu_tag = os.getenv("WMA_WATCH_CPU")
if cpu_tag == nil or cpu_tag == "" then cpu_tag = ":maincpu" end
local space_name = os.getenv("WMA_WATCH_SPACE")
if space_name == nil or space_name == "" then space_name = "program" end
local addr_start = parse_addr(os.getenv("WMA_WATCH_START"), 0x00)
local addr_end = parse_addr(os.getenv("WMA_WATCH_END"), 0x7ff)
local stride = parse_addr(os.getenv("WMA_WATCH_STRIDE"), 1)
if stride < 1 then stride = 1 end
local out = os.getenv("WMA_WATCH_LOG")
if out == nil or out == "" then out = "/tmp/wma_watch_ram.log" end

if addr_start > addr_end then
	print(string.format(
		"WMA scoremap watch: invalid range 0x%x > 0x%x", addr_start, addr_end))
	os.exit(1)
end

local m = manager.machine
local cpu = m.devices[cpu_tag]
if not cpu then
	print("WMA scoremap watch: no CPU device '" .. cpu_tag .. "'")
	os.exit(1)
end
local space = cpu.spaces[space_name]
if not space then
	print("WMA scoremap watch: CPU '" .. cpu_tag ..
		"' has no space '" .. space_name .. "'")
	os.exit(1)
end

local bytes = math.floor((addr_end - addr_start) / stride) + 1
print(string.format(
	"WMA scoremap watch: %s/%s 0x%x..0x%x stride %d (%d bytes/s) -> %s",
	cpu_tag, space_name, addr_start, addr_end, stride, bytes, out))
if bytes > 0x10000 and stride == 1 then
	print("WMA scoremap watch: WARNING large range with stride 1; " ..
		"set WMA_WATCH_STRIDE to bound the log size")
end

local function read_byte(addr)
	local ok, value = pcall(function() return space:read_direct_u8(addr) end)
	if ok and value ~= nil then return value & 0xff end
	return 0xff
end

local f = io.open(out, "a")
local n = 0

emu.register_frame_done(function()
	n = n + 1
	if n % 60 == 0 then
		local t = {}
		for a = addr_start, addr_end, stride do
			t[#t + 1] = string.format("%02x", read_byte(a))
		end
		f:write("RAM " .. n .. " " .. table.concat(t) .. "\n")
		-- A timestamped screenshot every 5 s so the on-screen score can be
		-- matched to the RAM offline (read with the -snapshot_directory output).
		if n % 300 == 0 then
			pcall(function() m.video:snapshot(); f:write("SHOT " .. n .. "\n") end)
		end
		f:flush()
	end
end)
