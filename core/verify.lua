-- Score verification script for MAME replay (T33, docs/05).
--
-- Run as:
--   mame <driver> -video none -sound none -nothrottle \
--       -autoboot_script core/verify.lua
--
-- Required env vars:
--   VERIFY_LOG_PATH   Path to the gzip(JSON) input log artifact.
--   VERIFY_SCOREMAP  Path to the driver's scoremap JSON file (optional; every
--                    player slot in it is read and printed).
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

-- Parse the scoremap `players` array. Each entry carries its own
-- slot/cpu/space/addr/len/format/endian (docs/contracts/scoremap.md); a map with
-- several slots (T47) yields one table per player rather than just the first.
local function parse_scoremap(text)
    local version = tonumber(text:match('"v"%s*:%s*(%d+)')) or 1
    local players = {}
    local body = text:match('"players"%s*:%s*%[(.-)%]')
    if not body then
        return { version = version, players = players }
    end
    for entry in body:gmatch("%b{}") do
        local addr_hex = entry:match('"addr"%s*:%s*"0x([0-9a-fA-F]+)"')
        local len_val = entry:match('"len"%s*:%s*(%d+)')
        local fmt = entry:match('"format"%s*:%s*"([^"]+)"')
        if addr_hex and len_val and fmt then
            players[#players + 1] = {
                slot = tonumber(entry:match('"slot"%s*:%s*(%d+)')) or 0,
                cpu = entry:match('"cpu"%s*:%s*"([^"]+)"') or ":maincpu",
                space = entry:match('"space"%s*:%s*"([^"]+)"') or "program",
                addr = tonumber(addr_hex, 16),
                len = tonumber(len_val),
                format = fmt,
                endian = entry:match('"endian"%s*:%s*"([^"]+)"') or "little",
            }
        end
    end
    return { version = version, players = players }
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

-- A scoremap may only point at RAM-backed addresses (docs/contracts/scoremap.md):
-- a direct read has no side effects, unlike an address-space handler. Returns nil
-- when no direct pointer exists so the caller reports it instead of running a
-- handler that could mutate machine state.
local function read_direct_byte(space, addr)
    local ok, value = pcall(function() return space:read_direct_u8(addr) end)
    if ok and value ~= nil then return value & 0xff end
    return nil
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
      " end_frame=" .. tostring(log["end"].frame))

-- Load scoremap if available.
local scoremap = nil
if SCOREMAP_PATH ~= "" then
    local ok, err = pcall(function()
        local sc = assert(read_file(SCOREMAP_PATH))
        local parsed = assert(parse_scoremap(sc))
        scoremap = parsed
        print("VERIFY scoremap: " .. tostring(#parsed.players) .. " player slot(s)")
        for _, p in ipairs(parsed.players) do
            print(string.format(
                "VERIFY scoremap: slot=%d %s/%s addr=0x%x len=%d format=%s endian=%s",
                p.slot, p.cpu, p.space, p.addr, p.len, p.format, p.endian))
        end
    end)
    if not ok then
        print("WARNING: could not load scoremap " .. SCOREMAP_PATH .. ": " .. tostring(err))
        scoremap = nil
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
if scoremap and #scoremap.players > 0 then
    -- One entry per seated slot (T47); each carries its own cpu/space/address.
    for _, p in ipairs(scoremap.players) do
        slots_to_read[#slots_to_read + 1] = p
    end
else
    -- No scoremap: read every slot present in start.players.
    for _, p in ipairs(log.start.players) do
        slots_to_read[#slots_to_read + 1] = { slot = p.slot, addr = nil }
    end
end

for _, entry in ipairs(slots_to_read) do
    local slot = entry.slot
    if entry.addr then
        local entry_cpu = m.devices[entry.cpu or ":maincpu"] or cpu
        local entry_space = entry_cpu.spaces[entry.space or "program"] or mem
        local bytes = {}
        local missing = false
        for i = 0, entry.len - 1 do
            local byte = read_direct_byte(entry_space, entry.addr + i)
            if byte == nil then
                missing = true
                break
            end
            bytes[i + 1] = byte
        end
        if missing then
            print("SCORE " .. tostring(slot) .. " ERROR no direct pointer at 0x" ..
                string.format("%x", entry.addr))
        else
            local score, err = decode_score(bytes, entry)
            if score then
                print("SCORE " .. tostring(slot) .. " " .. tostring(score))
            else
                print("SCORE " .. tostring(slot) .. " ERROR " .. tostring(err))
            end
        end
    else
        print("SCORE " .. tostring(slot) .. " 0  (no scoremap)")
    end
end

print("VERIFY DONE")
os.exit(0)
