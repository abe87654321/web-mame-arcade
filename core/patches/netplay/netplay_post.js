// license:BSD-3-Clause
// copyright-holders:Web MAME Arcade
//
// Netplay hooks for the Web MAME Arcade core (T20). Wraps the extern "C"
// netplay_* ABI from core/patches/netplay/netplay.cpp into the ergonomic
// Module.netplay shape the typed wrapper expects
// (packages/web/src/core/module.ts NetplayHooks). Prefer going through the
// wrapper; this is the raw Emscripten glue.
//
// cwrap is resolved lazily, at call time: newer Emscripten's cwrap returns the
// wasm export directly (getCFunc) rather than a deferred closure, and this
// post-js runs before the async wasm instance assigns Module['_netplay_*']. A
// load-time cwrap would therefore capture `undefined` and every call would
// throw "_x is not a function". Resolving per call is safe — these run after
// onRuntimeInitialized, when the exports exist.

var WMA_NETPLAY = (function () {
	return {
		enable: function () {
			Module.cwrap('netplay_enable', null, [])();
		},
		setInputs: function (frame, p1, p2, p3, p4) {
			Module.cwrap('netplay_set_inputs', null, ['number', 'number', 'number', 'number', 'number'])(
				frame >>> 0, p1 & 0xffff, p2 & 0xffff, p3 & 0xffff, p4 & 0xffff);
		},
		ready: function (frame) {
			return Module.cwrap('netplay_ready', 'number', ['number'])(frame >>> 0) !== 0;
		},
		step: function (frame) {
			Module.cwrap('netplay_step', null, ['number'])(frame >>> 0);
		},
		saveState: function () {
			var size = Module.cwrap('netplay_state_size', 'number', [])();
			if (size <= 0)
				throw new Error('MAME core does not support save states');
			var ptr = Module._malloc(size);
			try {
				if (!Module.cwrap('netplay_save_state', 'number', ['number'])(ptr))
					throw new Error('netplay_save_state failed');
				return Module.HEAPU8.slice(ptr, ptr + size);
			} finally {
				Module._free(ptr);
			}
		},
		loadState: function (state) {
			var size = Module.cwrap('netplay_state_size', 'number', [])();
			if (size <= 0)
				throw new Error('MAME core does not support save states');
			if (state.length !== size)
				throw new Error('state size mismatch: got ' + state.length + ', want ' + size);
			var ptr = Module._malloc(size);
			try {
				Module.HEAPU8.set(state, ptr);
				if (!Module.cwrap('netplay_load_state', 'number', ['number'])(ptr))
					throw new Error('netplay_load_state failed');
			} finally {
				Module._free(ptr);
			}
		},
		hash: function () {
			return Module.cwrap('netplay_hash', 'number', [])() >>> 0;
		}
	};
})();

Module.netplay = WMA_NETPLAY;

// The stock scripts/resources/emscripten/emscripten_post.js defines JSMAME in
// its own scope but never attaches it to Module, and the typed wrapper
// (MameCore.reset/destroy) reads Module.JSMAME. This post-js runs after it.
if (typeof JSMAME !== 'undefined')
	Module.JSMAME = JSMAME;
