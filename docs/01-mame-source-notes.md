# 01 · Findings in the MAME source

Studied `mamedev/mame` master, commit `b67e5bc` (7 Oct 2026); this is the **pinned** submodule commit for
v1 — bump it only as a deliberate, replay-tested change. Re-check line numbers when bumping the submodule.

| Area | Location | Meaning for us |
| --- | --- | --- |
| Browser build | `docs/source/initialsetup/compilingmame.rst` ("Emscripten Javascript and HTML") | Emscripten 6.0.2+, `embuilder build sdl3 sdl3_ttf`, `emmake make SUBTARGET=x SOURCES=src/mame/.../driver.cpp`. One small build per driver family. |
| Browser main loop | `src/emu/machine.cpp`, `running_machine::emscripten_main_loop()` (~l.1401) | Called by `emscripten_set_main_loop`; each call advances emulated time by fixed 1/60 s whenever the browser asks. **Patch point** for the frame gate. |
| JS hooks | `machine.cpp` ~l.1449-1477 | Existing: `emscripten_soft_reset`, `emscripten_hard_reset`, `emscripten_exit`, `emscripten_save(name)`, `emscripten_load(name)`. |
| In-memory states | `src/emu/save.h`: `save_manager::write_buffer()/read_buffer()`, class `rewinder` | RAM save states without file I/O → rollback, late join. |
| Save support flag | `src/emu/gamedrv.h`: `MACHINE_SUPPORTS_SAVE` | Filter the online catalogue on it. |
| Scripted input | `docs/source/luascript/ref-input.rst`: `field:set_value(v)`, `field:clear_value()` | Verifier injects inputs this way. |
| Score reading | `plugins/hiscore/` (`hiscore.dat`, `init.lua`, `mem:read_u8(addr)`) | RAM addresses of high-score tables for thousands of games. |

Determinism: same build + ROM + settings + per-frame input ⇒ same result. Everything relies on it.
