-- T02 determinism spike script.
--
-- Loaded by core/determinism-spike.sh, which generates a per-run bootstrap that
-- calls this module's returned function:
--
--   local run = dofile("<repo>/core/determinism/spike.lua")
--   run("record", 36000, "/tmp/.../hash")
--
-- (Globals cannot be used: MAME runs the autoboot script in a sandbox _ENV that
-- a dofile()'d file does not inherit.)
--
-- mode == "record"   -> drive deterministic inputs every frame
--                          "playback" -> inject nothing (inputs come from the .inp)
-- frames             -> run exactly this many emulated frames, then hash and exit
-- out                -> path to write SPIKE_FRAMES=/SPIKE_HASH=
--
-- The hash covers all memory shares (gridlee RAM: spriteram, videoram, nvram)
-- followed by all memory regions (ROM/RAM images). Tags are sorted so the fold
-- order is stable. Nothing here may depend on wall-clock time or host state.

return function(mode, frames, out)
  local MASK64 = 0xFFFFFFFFFFFFFFFF
  local FNV_OFFSET = 0xcbf29ce484222325
  local FNV_PRIME = 0x100000001b3

  local function fold_byte(h, b)
    h = (h ~ b) & MASK64
    h = (h * FNV_PRIME) & MASK64
    return h
  end

  local function fold_string(h, s)
    for i = 1, #s do
      h = fold_byte(h, s:byte(i))
    end
    return h
  end

  local function sorted_keys(t)
    local keys = {}
    for k in pairs(t) do
      keys[#keys + 1] = k
    end
    table.sort(keys)
    return keys
  end

  local function hash_ram()
    local h = FNV_OFFSET
    local mem = manager.machine.memory

    for _, tag in ipairs(sorted_keys(mem.shares)) do
      local share = mem.shares[tag]
      h = fold_string(h, "S:" .. tag)
      for off = 0, share.size - 1 do
        h = fold_byte(h, share:read_u8(off))
      end
    end

    for _, tag in ipairs(sorted_keys(mem.regions)) do
      local region = mem.regions[tag]
      h = fold_string(h, "R:" .. tag)
      h = fold_string(h, region:read(0, region.size))
    end

    return h
  end

  -- Deterministic input schedule. Digital controller fields toggle on a fixed
  -- phase derived from their mask; coin/start are pulsed once so the game leaves
  -- attract mode. Fields are applied in a sorted order (independent of Lua table
  -- iteration order) and each value is a function of the frame counter only.
  local function drive(frame)
    local ports = manager.machine.ioport.ports
    local seen = {}
    local fields = {}
    for _, port in pairs(ports) do
      for _, field in pairs(port.fields) do
        if field.type_class == "controller" and not field.is_analog then
          local key = field.port.tag .. ":" .. field.mask
          if not seen[key] then
            seen[key] = true
            fields[#fields + 1] = field
          end
        end
      end
    end
    table.sort(fields, function(a, b)
      if a.port.tag ~= b.port.tag then
        return a.port.tag < b.port.tag
      end
      return a.mask < b.mask
    end)
    for _, field in ipairs(fields) do
      local pressed = ((frame + field.mask) % 120) < 60
      field:set_value(pressed and 1 or 0)
    end

    -- Coin/start are INPUT_CLASS_MISC, so they are not covered above; pulse them.
    local in1 = ports[":IN1"] or ports["IN1"]
    if in1 then
      local coin1 = in1:field(0x01)
      if coin1 then coin1:set_value((frame >= 60 and frame < 65) and 1 or 0) end
      local start1 = in1:field(0x04)
      if start1 then start1:set_value((frame >= 120 and frame < 125) and 1 or 0) end
    end
  end

  local finish = function(n)
    local hex = string.format("%016x", hash_ram())
    local f = assert(io.open(out, "w"))
    f:write(string.format("SPIKE_FRAMES=%d\nSPIKE_HASH=%s\n", n, hex))
    f:close()
    emu.print_info(string.format("SPIKE_HASH=%s frames=%d", hex, n))
    manager.machine:exit()
  end

  local frame = 0
  local done = false

  -- The returned subscription MUST be kept reachable: MAME drops the notifier
  -- when its subscription is garbage-collected. Root it in the globals table.
  local sub = emu.add_machine_frame_notifier(function()
    if done then
      return
    end
    frame = frame + 1
    if mode == "record" then
      drive(frame)
    end
    if frame >= frames then
      done = true
      finish(frame)
    end
  end)
  rawset(_G, "__wma_spike_frame_sub", sub)
end
