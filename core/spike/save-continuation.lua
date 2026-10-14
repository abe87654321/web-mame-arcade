-- T46 native save/load *continuation* probe.
--
-- The T28 round-trip (core/spike/save-hash.lua) only hashes right after a load,
-- so a save that silently dropped or re-ordered state still passes it. This
-- script answers the stronger question netplay actually depends on: after
-- `buffer_load(snapshot)`, does running the *same* frames reproduce the future
-- exactly?
--
--   frame 0 .. boot-1                       (free-run)
--   snapshot = buffer_save()                boot
--   frame boot .. boot+span-1               -> forward (ram + snapshot)
--   buffer_load(snapshot)
--   frame boot .. boot+span-1               -> reload  (ram + snapshot)
--
-- `forward == reload` (RAM and full save buffer) is the netplay invariant.
-- It also reports whether `buffer_load` re-serialises to the same bytes it
-- loaded (loadByteEqual), separating a behavioural divergence from save-manager
-- canonicalisation. Native build only; loaded by native-save-continuation.sh.
--
-- Env: WMA_SI_BOOT  frames to boot before the save (default 120)
--      WMA_SI_SPAN  frames to advance before/after the load (default 120)
--      WMA_SI_OUT   path to write SI_* lines to
--
-- Determinism: only the frame counter drives the run; no wall clock, no random.
-- Inputs are the headless defaults (constant), so both runs see identical input.

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

  -- Same fold as core/determinism/spike.lua and save-hash.lua: every memory
  -- share then every memory region, in sorted tag order.
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

  -- First differing byte offset between two Lua strings, or -1 when equal.
  local function first_diff(a, b)
    local n = math.min(#a, #b)
    for i = 1, n do
      if a:byte(i) ~= b:byte(i) then
        return i - 1
      end
    end
    return #a == #b and -1 or n
  end

  local boot = tonumber(os.getenv("WMA_SI_BOOT") or "120")
  local span = tonumber(os.getenv("WMA_SI_SPAN") or "120")
  local out = os.getenv("WMA_SI_OUT") or "save-continuation.out"

  local fields = {}
  local function record(k, v)
    fields[#fields + 1] = string.format("%s=%s", k, v)
  end

  local phase = 1
  local frame = 0
  local snap = nil
  local snap_at_save = nil
  local ram_at_save = nil
  local ram_forward = nil
  local snap_forward = nil

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
        record("SI_ERROR", "buffer_save: " .. tostring(s))
        write_out()
        manager.machine:exit()
        return
      end
      snap = s
      -- save() must be a pure snapshot: a second save with no step agrees.
      local again = manager.machine:buffer_save()
      snap_at_save = again
      record("SI_BYTES", #s)
      record("SI_SAVE_STABLE", first_diff(s, again) == -1 and "true" or "false")
      ram_at_save = hash_ram()
      phase = 2
    elseif phase == 2 and frame >= boot + span then
      ram_forward = hash_ram()
      snap_forward = manager.machine:buffer_save()
      manager.machine:buffer_load(snap)
      -- RAM immediately after the load, before any step: does buffer_load restore
      -- the machine's memory exactly?
      local ram_after_load = hash_ram()
      record("SI_RAM_AFTER_LOAD", string.format("%016x", ram_after_load))
      record("SI_RAM_AFTER_LOAD_EQ_SAVE", ram_after_load == ram_at_save and "true" or "false")
      -- SI_EXTRAS=1 additionally re-serialises straight after the load (which runs
      -- presave and may perturb the timer order) to check if the load is byte-pure.
      -- Off by default so the continuation comparison is not itself perturbed.
      if os.getenv("WMA_SI_EXTRAS") ~= nil then
        local resaved = manager.machine:buffer_save()
        local load_diff = first_diff(snap, resaved)
        record("SI_LOAD_BYTE_EQUAL", load_diff == -1 and "true" or "false")
        record("SI_LOAD_FIRST_DIFF", load_diff)
      end
      record("SI_RAM_AT_SAVE", string.format("%016x", ram_at_save))
      record("SI_RAM_FORWARD", string.format("%016x", ram_forward))
      record("SI_SNAP_FORWARD_EQ_SAVE", first_diff(snap, snap_forward) == -1 and "true" or "false")
      phase = 3
    elseif phase == 3 and frame >= boot + 2 * span then
      local ram_reload = hash_ram()
      local snap_reload = manager.machine:buffer_save()
      record("SI_RAM_RELOAD", string.format("%016x", ram_reload))
      record("SI_SNAP_FORWARD_EQ_RELOAD", first_diff(snap_forward, snap_reload) == -1 and "true" or "false")
      -- The netplay invariant is that the reloaded machine plays the same game:
      -- identical RAM at the same frame. The serialised buffer can legitimately
      -- differ in timer m_index canonicalisation, so it is reported, not gated.
      local ok = ram_forward == ram_reload
      record("SI_DET", ok and "PASS" or "FAIL")
      write_out()
      for _, line in ipairs(fields) do
        emu.print_info(line)
      end
      manager.machine:exit()
    end
  end)
  rawset(_G, "__wma_save_continuation_sub", sub)
end
