-- Score verification script for MAME replay (T33, docs/05).
--
-- Run as:
--   mame <driver> -video none -sound none -nothrottle \
--       -autoboot_script core/verify.lua
--
-- Required env vars:
--   VERIFY_LOG_PATH   Path to the gzip(JSON) input log artifact.
--   VERIFY_SCOREMAP  Path to the driver's scoremap JSON file (optional).
--
-- Reads the closed input log, feeds each frame's inputs into MAME, then
-- reads the score from RAM at the last frame and prints:
--   SCORE <slot> <score>
--
-- The score decoding (BCD / binary, endianness) matches the contract in
-- docs/contracts/scoremap.md and the TypeScript implementation in
-- packages/web/src/core/scoremap.ts.

local LOG_PATH = os.getenv("VERIFY_LOG_PATH")
local SCOREMAP_PATH = os.getenv("VERIFY_SCOREMAP") or ""

-- ─── Minimal gzip + JSON parser ───────────────────────────────────────────────

local function gunzip(bytes)
    local zlib = require("zlib")
    local inflate = zlib.inflate()
    return inflate(bytes)
end

local function read_file(path)
    local f = assert(io.open(path, "rb"))
    local data = f:read("*a")
    f:close()
    return data
end

-- Walk a Lua table (already parsed by loadstring) for the players array.
-- The top-level log object has keys: v, room, meta, start, end, frames.
local function find_players_array(obj, accumulator, depth)
    accumulator = accumulator or {}
    depth = depth or 0
    if depth > 16 then return accumulator end
    if type(obj) ~= "table" then return accumulator end
    if obj[1] ~= nil then
        for _, v in ipairs(obj) do
            find_players_array(v, accumulator, depth + 1)
        end
        return accumulator
    end
    for k, v in pairs(obj) do
        if k == "players" and type(v) == "table" and v[1] ~= nil then
            for _, p in ipairs(v) do
                accumulator[#accumulator + 1] = p
            end
        else
            find_players_array(v, accumulator, depth + 1)
        end
    end
    return accumulator
end

local function parse_scoremap(text)
    local players = {}
    local version = nil
    for word in text:gmatch('"(%w+)"%s*:%s*') do
        if word == "v" or word == "version" then
            local num = text:match('"v"%s*:%s*(%d+)')
            if num then version = tonumber(num) end
        end
    end
    local addr_hex = text:match('"addr"%s*:%s*"0x([0-9a-fA-F]+)"')
    local len_val = text:match('"len"%s*:%s*(%d+)')
    local fmt = text:match('"format"%s*:%s*"([^"]+)"')
    local endian_val = text:match('"endian"%s*:%s*"([^"]+)"')
    local slot_val = text:match('"slot"%s*:%s*(%d+)')
    if not addr_hex or not len_val or not fmt then
        return nil
    end
    return {
        version = version or 1,
        addr = tonumber(addr_hex, 16),
        len = tonumber(len_val),
        format = fmt,
        endian = endian_val or "little",
        slot = tonumber(slot_val) or 0,
    }
end

local function parse_log(text)
    local func = assert(load("return " .. text, "=verify", "t"))
    return func()
end

-- ─── Score decoding (matches packages/web/src/core/scoremap.ts) ─────────────────

local function decode_bcd(bytes, endian)
    local ordered = bytes
    if endian == "little" then
        ordered = {}
        for i = #bytes, 1, -1 do ordered[#ordered + 1] = bytes[i] end
    end
    local digits = ""
    for _, b in ipairs(ordered) do
        local high = b >> 4
        local low = b & 0x0f
        if high > 9 or low > 9 then
            return nil, "invalid bcd byte"
        end
        digits = digits .. tostring(high) .. tostring(low)
    end
    return tonumber(digits) or 0
end

local function decode_binary(bytes, endian)
    local ordered = bytes
    if endian == "little" then
        ordered = {}
        for i = #bytes, 1, -1 do ordered[#ordered + 1] = bytes[i] end
    end
    local value = 0
    for _, b in ipairs(ordered) do
        value = value * 256 + b
    end
    return value
end

local function decode_score(bytes, scoremap)
    if scoremap.format == "bcd" then
        return decode_bcd(bytes, scoremap.endian)
    elseif scoremap.format == "binary" then
        return decode_binary(bytes, scoremap.endian)
    end
    return nil, "unknown format"
end

-- ─── Input application ────────────────────────────────────────────────────────

local function apply_mask(mask, port_prefix)
    local m = manager.machine
    local iop = m.ioport
    -- Standard MAME field tokens for a 2-player arcade setup.
    -- Bit layout (docs/contracts/input-packet.md):
    --   0 up, 1 down, 2 left, 3 right, 4 B1
    --   8 up, 9 down, 10 left, 11 right, 12 B1  (player 2)
    local port = iop.ports[port_prefix]
    if not port then return end
    for name, field in pairs(port.fields) do
        local tok = field:token() or ""
        local bit = nil
        if     tok:find("UP")      then bit = 0
        elseif tok:find("DOWN")    then bit = 1
        elseif tok:find("LEFT")    then bit = 2
        elseif tok:find("RIGHT")   then bit = 3
        elseif tok:find("BUTTON")  then bit = 4
        elseif tok:find("START")   then bit = 10
        elseif tok:find("COIN")    then bit = 11
        end
        if bit == nil then
            -- try a simple CODE lookup via input_gate
        else
            local player_offset = 0
            if port_prefix:find("P2") or port_prefix:find("2") then
                player_offset = 8
            end
            local full_bit = bit + player_offset
            local is_set = ((mask >> full_bit) & 1) == 1
            field:set_value(is_set and 1 or 0)
        end
    end
end

-- Simpler approach: use input_gate directly with the standard MAME input tokens.
-- The 16-bit mask encodes player slots sequentially; player 0 starts at bit 0,
-- player 1 at bit 8.
local STANDARD_TOKENS = {
    { token = "P1_JOYSTICK_UP",    bit = 0 },
    { token = "P1_JOYSTICK_DOWN",  bit = 1 },
    { token = "P1_JOYSTICK_LEFT",  bit = 2 },
    { token = "P1_JOYSTICK_RIGHT", bit = 3 },
    { token = "P1_BUTTON1",       bit = 4 },
    { token = "P2_JOYSTICK_UP",    bit = 8 },
    { token = "P2_JOYSTICK_DOWN",  bit = 9 },
    { token = "P2_JOYSTICK_LEFT",   bit = 10 },
    { token = "P2_JOYSTICK_RIGHT",  bit = 11 },
    { token = "P2_BUTTON1",         bit = 12 },
}

local function apply_input_mask(mask)
    local m = manager.machine
    for _, entry in ipairs(STANDARD_TOKENS) do
        local is_set = ((mask >> entry.bit) & 1) == 1
        -- Use input_gate API: set_value(token_string, value)
        m:input():set_value(entry.token, is_set and 1 or 0)
    end
end

-- ─── Main ─────────────────────────────────────────────────────────────────────

if not LOG_PATH then
    print("ERROR: VERIFY_LOG_PATH not set")
    os.exit(1)
end

-- Read + decompress the input log.
local compressed = read_file(LOG_PATH)
local json_text = assert(gunzip(compressed))
local log = assert(parse_log(json_text))

print("VERIFY log: driver=" .. log.meta.driver ..
      " frames=" .. tostring(#log.frames) ..
      " end_frame=" .. tostring(log.end.frame))

-- Load scoremap if available.
local scoremap = nil
if SCOREMAP_PATH ~= "" then
    local ok, err = pcall(function()
        local sc = assert(read_file(SCOREMAP_PATH))
        scoremap = assert(parse_scoremap(sc))
        print("VERIFY scoremap: slot=" .. tostring(scoremap.slot) ..
              " addr=0x" .. string.format("%x", scoremap.addr) ..
              " len=" .. tostring(scoremap.len) ..
              " format=" .. scoremap.format ..
              " endian=" .. scoremap.endian)
    end)
    if not ok then
        print("WARNING: could not load scoremap " .. SCOREMAP_PATH .. ": " .. tostring(err))
    end
end

local m = manager.machine
local cpu = m.devices[log.meta.driver:match("^:*(.+)") or log.meta.driver]
if not cpu then
    cpu = m.devices[":maincpu"]
end

local mem = cpu.spaces["program"]

-- Feed each frame's inputs and step.
for frame_idx, player_masks in ipairs(log.frames) do
    for slot_idx, mask in ipairs(player_masks) do
        apply_input_mask(mask)
    end
    m:step()
end

-- Read scores from RAM.
local slots_to_read = {}
if scoremap then
    slots_to_read[#slots_to_read + 1] = scoremap
else
    -- No scoremap: read every slot present in start.players.
    for _, p in ipairs(log.start.players) do
        slots_to_read[#slots_to_read + 1] = { slot = p.slot, addr = nil }
    end
end

for _, entry in ipairs(slots_to_read) do
    local slot = entry.slot
    if entry.addr then
        local bytes = {}
        for i = 0, entry.len - 1 do
            bytes[i + 1] = mem:read_u8(entry.addr + i)
        end
        local score, err = decode_score(bytes, entry)
        if score then
            print("SCORE " .. tostring(slot) .. " " .. tostring(score))
        else
            print("SCORE " .. tostring(slot) .. " ERROR " .. tostring(err))
        end
    else
        print("SCORE " .. tostring(slot) .. " 0  (no scoremap)")
    end
end

print("VERIFY DONE")
os.exit(0)
