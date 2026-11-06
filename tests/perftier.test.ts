// Performance: Auto picks a quality level from the device (art/tier.ts), and the CSS/loops
// rules that keep a still duel from redrawing (lean.css, board/stage/livingField pacing).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deviceTier } from "../src/art/tier";

const android = "Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ipadAsMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// weak phones: Lite
assert.equal(deviceTier({ ua: android, mem: 4, cores: 8, gpu: "Mali-G52 MC2" }), 0, "Mali-G52 is Lite");
assert.equal(deviceTier({ ua: android, mem: 2, cores: 8, gpu: "Adreno (TM) 610" }), 0, "2 GB is Lite");
assert.equal(deviceTier({ ua: android, mem: 4, cores: 4, gpu: "Adreno (TM) 640" }), 0, "4 cores on a phone is Lite");
// mid-range phones: Balanced
assert.equal(deviceTier({ ua: android, mem: 8, cores: 8, gpu: "Adreno (TM) 642L" }), 1, "Adreno 642L is Balanced");
assert.equal(deviceTier({ ua: android, mem: 4, cores: 8, gpu: "Mali-G68 MC4" }), 1, "4 GB mid-range is Balanced");
// strong phones: Full
assert.equal(deviceTier({ ua: android, mem: 8, cores: 8, gpu: "Adreno (TM) 740" }), 2, "flagship Adreno is Full");
assert.equal(deviceTier({ ua: android, mem: 8, cores: 8, gpu: "Mali-G715-Immortalis MC11" }), 2, "Immortalis is Full");
// iPhones and iPads (Safari reports no memory and a capped core count): Balanced
assert.equal(deviceTier({ ua: iphone, cores: 4, gpu: "Apple GPU" }), 1, "iPhone is Balanced");
assert.equal(deviceTier({ ua: ipadAsMac, cores: 8, gpu: "Apple GPU", touch: 5 }), 1, "an iPad that says Mac is Balanced");
// computers
assert.equal(deviceTier({ ua: desktop, mem: 8, cores: 12, gpu: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" }), 2, "gaming PC is Full");
assert.equal(deviceTier({ ua: desktop, mem: 8, cores: 4, gpu: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)" }), 1, "4-core laptop is Balanced");
assert.equal(deviceTier({ ua: desktop, mem: 8, cores: 8, gpu: "ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)" }), 1, "old Intel HD is Balanced");
assert.equal(deviceTier({ ua: desktop, mem: 8, cores: 8, gpu: "Google SwiftShader" }), 0, "software rendering is Lite");
assert.equal(deviceTier({ ua: desktop, mem: 8, cores: 8, gpu: "Apple M2" }), 2, "Mac is Full");

// a still duel does not loop: the decorative CSS loops end on Balanced/Lite, and the loops that say something stay
const lean = readFileSync(new URL("../src/art/lean.css", import.meta.url), "utf8");
for (const sel of [".mate-act.r-idle", ".slv-sweep", ".tilt-sway", "backdrop-filter: none"]) assert.ok(lean.includes(sel), `lean.css covers ${sel}`);
for (const cue of ["tdots", ".pick", "tphase-btn", "tclock"]) assert.ok(!lean.includes(cue), `lean.css leaves the ${cue} cue looping`);
// the board, the stage's paused wait and the Field Spell scenery wait on timers, not a frame callback every vsync
const board = readFileSync(new URL("../src/art/board.ts", import.meta.url), "utf8");
assert.ok(/private later\(ms: number\)/.test(board) && /setTimeout\(this\.onTimer/.test(board), "board paces frames with a timer");
assert.ok(/!this\.busy && !this\.idleOn && isLean\(\)\) return;/.test(board), "board sleeps on Balanced/Lite once nothing moves");
const guard = readFileSync(new URL("../src/art/perfGuard.ts", import.meta.url), "utf8");
assert.ok(!/requestAnimationFrame\(/.test(guard), "the watchdog never runs a frame loop of its own");
const settings = readFileSync(new URL("../src/art/settings.ts", import.meta.url), "utf8");
assert.ok(/: 'auto';\n\}/.test(settings), "Auto is the default");

console.log("perftier: ok");
