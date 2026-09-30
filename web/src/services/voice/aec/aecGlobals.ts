/**
 * The emscripten glue of @ennuicastr/webrtcaec3.js assigns an undeclared
 * global (`WebRtcAec3Wasm = "data:application/wasm;base64,..."`), which throws
 * in the strict-mode worklet bundle. Declaring it first (this module is
 * imported before the glue) makes that a plain assignment.
 */
(globalThis as Record<string, unknown>).WebRtcAec3Wasm = undefined;
export {};
