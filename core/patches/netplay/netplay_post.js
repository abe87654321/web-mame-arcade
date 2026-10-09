// license:BSD-3-Clause
// copyright-holders:Web MAME Arcade
//
// Netplay hooks for the Web MAME Arcade core (T20). Wraps the extern "C"
// netplay_* ABI from core/patches/netplay/netplay.cpp into the ergonomic
// Module.netplay shape the typed wrapper expects
// (packages/web/src/core/module.ts NetplayHooks). Prefer going through the
// wrapper; this is the raw Emscripten glue.

var WMA_NETPLAY = (function () {
	var _enable = Module.cwrap('netplay_enable', null, []);
	var _set_inputs = Module.cwrap('netplay_set_inputs', null, ['number', 'number', 'number', 'number', 'number']);
	var _ready = Module.cwrap('netplay_ready', 'number', ['number']);
	var _step = Module.cwrap('netplay_step', null, ['number']);
	var _state_size = Module.cwrap('netplay_state_size', 'number', []);
	var _save_state = Module.cwrap('netplay_save_state', 'number', ['number']);
	var _load_state = Module.cwrap('netplay_load_state', 'number', ['number']);
	var _hash = Module.cwrap('netplay_hash', 'number', []);

	return {
		enable: function () {
			_enable();
		},
		setInputs: function (frame, p1, p2, p3, p4) {
			_set_inputs(frame >>> 0, p1 & 0xffff, p2 & 0xffff, p3 & 0xffff, p4 & 0xffff);
		},
		ready: function (frame) {
			return _ready(frame >>> 0) !== 0;
		},
		step: function (frame) {
			_step(frame >>> 0);
		},
		saveState: function () {
			var size = _state_size();
			if (size <= 0)
				throw new Error('MAME core does not support save states');
			var ptr = Module._malloc(size);
			try {
				if (!_save_state(ptr))
					throw new Error('netplay_save_state failed');
				return Module.HEAPU8.slice(ptr, ptr + size);
			} finally {
				Module._free(ptr);
			}
		},
		loadState: function (state) {
			var size = _state_size();
			if (size <= 0)
				throw new Error('MAME core does not support save states');
			if (state.length !== size)
				throw new Error('state size mismatch: got ' + state.length + ', want ' + size);
			var ptr = Module._malloc(size);
			try {
				Module.HEAPU8.set(state, ptr);
				if (!_load_state(ptr))
					throw new Error('netplay_load_state failed');
			} finally {
				Module._free(ptr);
			}
		},
		hash: function () {
			return _hash() >>> 0;
		}
	};
})();

Module.netplay = WMA_NETPLAY;
