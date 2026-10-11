-- T28 netplay feasibility spike (native).
--
-- Measures the per-frame cost a rollback ring buffer (T40) or a server-authoritative
-- host (T45) would pay: the machine-state byte size and the save/load/hash wall time,
-- plus a save -> advance -> load round-trip RAM-hash equality check.
--
-- Loaded by core/spike/native-save-hash.sh, which generates a per-run bootstrap:
--
--   dofile("<repo>/core/spike/save-hash.lua")()
--
-- (Globals cannot be used: MAME runs the autoboot script in a sandbox _ENV that a
-- dofile()'d file does not inherit. Options therefore come from the environment.)
--
-- Env: WMA_SPIKE_BOOT  frames to boot before measuring (default 60)
--      WMA_SPIKE_ITERS timed iterations per primitive (default 50)
--      WMA_SPIKE_SPAN  frames between the save and the load check (default 30)
--      WMA_SPIKE_OUT   path to write SPIKE_* lines to
--
-- Determinism: only the frame counter drives the run; no wall clock, no random.

return function()
  local MASK = 0xFFFFFFFFFFFFFFFF
  local FNV_OFFSET = 0xcbf29ce484222325
  local FNV_PRIME = 0x100000001b3

  local function fold_byte(h, b)
    h = (h ~ b) & MASK
    return (h * FNV_PRIME) & MASK
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

  -- Same fold as core/determinism/spike.lua: every memory share then every memory
  -- region, in sorted tag order. Used only to compare a state against itself.
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

  local boot = tonumber(os.getenv("WMA_SPIKE_BOOT") or "60")
  local iters = tonumber(os.getenv("WMA_SPIKE_ITERS") or "50")
  local span = tonumber(os.getenv("WMA_SPIKE_SPAN") or "30")
  local out = os.getenv("WMA_SPIKE_OUT") or "save-hash.out"

  local function avg_ms(fn)
    local t0 = os.clock()
    for _ = 1, iters do
      fn()
    end
    return (os.clock() - t0) * 1000.0 / iters
  end

  local fields = {}
  local function record(k, v)
    fields[#fields + 1] = string.format("%s=%s", k, v)
  end

  local phase = 1
  local frame = 0
  local snap = nil
  local h0 = nil

  local function write_out()
    local f = assert(io.open(out, "w"))
    f:write(table.concat(fields, "\n") .. "\n")
    f:close()
  end

  local sub = emu.add_machine_frame_notifier(function()
    frame = frame + 1
    if phase == 1 and frame >= boot then
      local ok, s = pcall(function()
        return manager.machine:buffer_save()
      end)
      if not ok then
        record("SPIKE_ERROR", "buffer_save: " .. tostring(s))
        write_out()
        manager.machine:exit()
        return
      end
      snap = s
      h0 = hash_ram()
      local size = #snap
      local save_ms = avg_ms(function()
        manager.machine:buffer_save()
      end)
      local load_ms = avg_ms(function()
        manager.machine:buffer_load(snap)
      end)
      local hash_ms = avg_ms(function()
        hash_ram()
      end)
      record("SPIKE_FRAMES", boot)
      record("SPIKE_BYTES", size)
      record("SPIKE_ITERS", iters)
      record("SPIKE_SAVE_MS", string.format("%.3f", save_ms))
      record("SPIKE_LOAD_MS", string.format("%.3f", load_ms))
      record("SPIKE_REFHASH_MS", string.format("%.3f", hash_ms))
      phase = 2
    elseif phase == 2 and frame >= boot + span then
      manager.machine:buffer_load(snap)
      local h1 = hash_ram()
      record("SPIKE_DET", h0 == h1 and "PASS" or "FAIL")
      record("SPIKE_HASH_A", string.format("%016x", h0))
      record("SPIKE_HASH_B", string.format("%016x", h1))
      write_out()
      for _, line in ipairs(fields) do
        emu.print_info(line)
      end
      manager.machine:exit()
    end
  end)
  rawset(_G, "__wma_save_hash_sub", sub)
end
