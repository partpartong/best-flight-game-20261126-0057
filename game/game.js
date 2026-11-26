// RIDGE RUNNER — a mountain-valley flight game.
// Pure Canvas 2D, no libraries, no network, no external assets.
// Fly the valley, thread the rings, land on the runway.
//
// Controls: Arrow keys / WASD pitch + roll, Shift/Ctrl throttle up/down,
// mouse steers, C cockpit/chase view, M mute, P pause, R restart.
// Start with Enter or a click. URL ?shot=chase|cockpit|runway|rings
// stages a fixed shot for screenshots (autopilot, no overlays).

'use strict';

// ---------------------------------------------------------------- utils
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t); // smoothstep 0..1

// Deterministic PRNG (mulberry32) so the world is the same every load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261126);

// Integer-lattice value noise, deterministic, seeded.
function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263 + 0x9E3779B9) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = smooth(fx), sz = smooth(fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}

// ---------------------------------------------------------------- terrain
// World: x in [-4000, 4000], z in [0, 12000]. The valley course runs
// along x ~ 0 toward +z. A lake sits left of the valley, a high ridge
// and snow peaks rise to the right, fields patch the valley floor.
const WORLD = { xMin: -4000, xMax: 4000, zMin: -200, zMax: 12000 };
const RUNWAY = { x0: -32, x1: 32, z0: 80, z1: 920, y: 0 };

function baseHeight(x, z) {
  // Rolling hills, two octaves of value noise.
  let h = vnoise(x * 0.0016, z * 0.0016) * 90;
  h += vnoise(x * 0.006 + 40, z * 0.006 + 40) * 22;
  // Big ridge rising to the east (+x) and a snow peak north-east.
  const ridge = smooth(clamp((x - 600) / 2200, 0, 1));
  h += ridge * ridge * 150;
  const dx = x - 2400, dz = z - 7200;
  h += 190 * Math.exp(-(dx * dx + dz * dz) / (2 * 1400 * 1400));
  // A second peak west, lower.
  const dx2 = x + 2600, dz2 = z - 4200;
  h += 110 * Math.exp(-(dx2 * dx2 + dz2 * dz2) / (2 * 1200 * 1200));
  // Lake basin west of the valley (below water level).
  const lx = x + 1300, lz = z - 5200;
  const lake = Math.exp(-(lx * lx + lz * lz) / (2 * 950 * 950));
  h -= lake * 46;
  // Outside the lake basin the ground never dips below 3 m, so no
  // stray puddles appear beside the runway or in the valley.
  if (lake < 0.25) h = Math.max(h, 3);
  // Valley floor: keep the course corridor gentle near x = 0.
  const corridor = Math.exp(-(x * x) / (2 * 420 * 420));
  h = lerp(h, Math.min(h, 26), corridor * 0.85);
  return h;
}

// How much the runway flattening applies at a point (1 on the strip,
// fading to 0 about 90 m to the sides and 120 m past the ends).
function runwayBlend(x, z) {
  const bx = smooth(clamp((x - (RUNWAY.x0 - 90)) / 90, 0, 1)) *
             (1 - smooth(clamp((x - (RUNWAY.x1 + 90)) / 90, 0, 1)));
  const bz = smooth(clamp((z - (RUNWAY.z0 - 120)) / 120, 0, 1)) *
             (1 - smooth(clamp((z - (RUNWAY.z1 + 120)) / 120, 0, 1)));
  return bx * bz;
}

// Lake-basin factor (1 at the lake centre, fading out): the only place
// low ground is water.
function lakeFactor(x, z) {
  const lx = x + 1300, lz = z - 5200;
  return Math.exp(-(lx * lx + lz * lz) / (2 * 950 * 950));
}

function terrainHeight(x, z) {
  let h = baseHeight(x, z);
  // Flatten the runway strip smoothly to y = 0.
  return lerp(h, RUNWAY.y, runwayBlend(x, z));
}

// ---------------------------------------------------------------- state
const VIEW_CHASE = 0, VIEW_COCKPIT = 1;
const PHASE_TITLE = 0, PHASE_FLY = 1, PHASE_PAUSE = 2, PHASE_CRASH = 3, PHASE_LAND = 4;

const RINGS = [
  { x: 0,    y: 95,  z: 1600, r: 42 },
  { x: 260,  y: 120, z: 2700, r: 40 },
  { x: -320, y: 150, z: 3900, r: 44 },
  { x: -900, y: 130, z: 5100, r: 40 }, // over the lake shore
  { x: -300, y: 190, z: 6400, r: 42 },
  { x: 500,  y: 230, z: 7700, r: 40 },
  { x: 1200, y: 260, z: 9000, r: 44 },
  { x: 300,  y: 150, z: 10200, r: 46 }, // final, lines up with the runway
];

const S = {
  phase: PHASE_TITLE,
  view: VIEW_CHASE,
  // Aircraft: position (m), heading rad (0 = +z), pitch/roll rad, speed m/s.
  x: 0, y: 60, z: 320, heading: 0, pitch: 0, roll: 0,
  speed: 62, throttle: 0.55, vs: 0,
  score: 0, ringIndex: 0, ringsHit: 0,
  time: 0, flightTime: 0,
  crashReason: '', landBonus: 0, courseComplete: false,
  message: '', messageT: 0, warn: '', muted: false,
  camX: 0, camY: 0, camZ: 0, camYaw: 0, camPitch: 0, camRoll: 0,
  shot: null, autopilot: false,
  keys: {}, mouseX: 0, mouseY: 0, mouseActive: false,
};

function showMessage(text, dur) {
  S.message = text; S.messageT = dur || 2.2;
}

function resetFlight(start) {
  const s = start || {};
  S.x = s.x ?? 0; S.y = s.y ?? 60; S.z = s.z ?? 320;
  S.heading = s.heading ?? 0; S.pitch = 0; S.roll = 0;
  S.speed = s.speed ?? 62; S.throttle = s.throttle ?? 0.55; S.vs = 0;
  S.score = 0; S.ringIndex = 0; S.ringsHit = 0;
  S.flightTime = 0; S.crashReason = ''; S.landBonus = 0;
  S.courseComplete = false; S.warn = '';
  S.phase = PHASE_FLY;
  showMessage(s.msg || 'Cleared for takeoff — fly the rings!', 2.6);
}

// ---------------------------------------------------------------- input
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
}
window.addEventListener('resize', resize);
resize();

const KEYMAP = {
  ArrowUp: 'pitchDown', KeyW: 'pitchDown',
  ArrowDown: 'pitchUp', KeyS: 'pitchUp',
  ArrowLeft: 'rollLeft', KeyA: 'rollLeft',
  ArrowRight: 'rollRight', KeyD: 'rollRight',
  ShiftLeft: 'thrUp', ShiftRight: 'thrUp',
  ControlLeft: 'thrDown', ControlRight: 'thrDown',
  Equal: 'thrUp', Minus: 'thrDown',
};
window.addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) { S.keys[KEYMAP[e.code]] = true; e.preventDefault(); }
  if (e.code === 'Enter' || e.code === 'Space') {
    if (S.phase === PHASE_TITLE) { resetFlight(); e.preventDefault(); }
    else if (S.phase === PHASE_CRASH || S.phase === PHASE_LAND) { resetFlight(); e.preventDefault(); }
  }
  if (e.code === 'KeyC' && S.phase === PHASE_FLY) {
    S.view = S.view === VIEW_CHASE ? VIEW_COCKPIT : VIEW_CHASE;
  }
  if (e.code === 'KeyR' && S.phase !== PHASE_TITLE) resetFlight();
  if (e.code === 'KeyP' && (S.phase === PHASE_FLY || S.phase === PHASE_PAUSE)) {
    S.phase = S.phase === PHASE_FLY ? PHASE_PAUSE : PHASE_FLY;
  }
  if (e.code === 'KeyM') { S.muted = !S.muted; setMuted(S.muted); }
});
window.addEventListener('keyup', (e) => {
  if (KEYMAP[e.code]) S.keys[KEYMAP[e.code]] = false;
});
canvas.addEventListener('mousemove', (e) => {
  S.mouseX = (e.clientX / W) * 2 - 1;   // -1 left .. +1 right
  S.mouseY = (e.clientY / H) * 2 - 1;   // -1 top .. +1 bottom
  S.mouseActive = true;
});
canvas.addEventListener('mousedown', () => {
  if (S.phase === PHASE_TITLE) resetFlight();
  else if (S.phase === PHASE_CRASH || S.phase === PHASE_LAND) resetFlight();
});

// ---------------------------------------------------------------- audio
// Everything synthesised with WebAudio — no audio files, no network.
let AC = null, engOsc = null, engOsc2 = null, engGain = null, windGain = null, masterGain = null;
function initAudio() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = AC.createGain(); masterGain.gain.value = 0.5;
    masterGain.connect(AC.destination);
    engOsc = AC.createOscillator(); engOsc.type = 'sawtooth';
    engOsc.frequency.value = 70;
    engOsc2 = AC.createOscillator(); engOsc2.type = 'square';
    engOsc2.frequency.value = 35;
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    engGain = AC.createGain(); engGain.gain.value = 0.0;
    engOsc.connect(lp); engOsc2.connect(lp);
    lp.connect(engGain); engGain.connect(masterGain);
    engOsc.start(); engOsc2.start();
    // Wind: looped noise buffer through a bandpass.
    const len = AC.sampleRate * 2;
    const buf = AC.createBuffer(1, len, AC.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = AC.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.6;
    windGain = AC.createGain(); windGain.gain.value = 0.0;
    src.connect(bp); bp.connect(windGain); windGain.connect(masterGain);
    src.start();
  } catch (err) { AC = null; }
}
function setMuted(m) { if (masterGain) masterGain.gain.value = m ? 0 : 0.5; }
function blip(freq, dur, type, vol, when) {
  if (!AC || S.muted) return;
  const t = AC.currentTime + (when || 0);
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(masterGain);
  o.start(t); o.stop(t + dur + 0.05);
}
function ringChime() { blip(659, 0.35, 'sine', 0.3); blip(988, 0.5, 'sine', 0.28, 0.09); }
function crashSound() {
  if (!AC || S.muted) return;
  const t = AC.currentTime;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  o.connect(g); g.connect(masterGain); o.start(t); o.stop(t + 0.65);
  blip(90, 0.4, 'sawtooth', 0.2);
}
function updateAudio() {
  if (!AC) return;
  const flying = S.phase === PHASE_FLY;
  const target = flying ? 0.05 + S.throttle * 0.06 : 0.0;
  engGain.gain.setTargetAtTime(target, AC.currentTime, 0.1);
  engOsc.frequency.setTargetAtTime(55 + S.throttle * 75 + S.speed * 0.25, AC.currentTime, 0.1);
  engOsc2.frequency.setTargetAtTime(28 + S.throttle * 38, AC.currentTime, 0.1);
  windGain.gain.setTargetAtTime(flying ? clamp(S.speed / 900, 0, 0.12) : 0, AC.currentTime, 0.15);
}
window.addEventListener('pointerdown', initAudio, { once: true });
window.addEventListener('keydown', initAudio, { once: true });

// ---------------------------------------------------------------- physics
// Arcade flight model: throttle sets target speed, pitch trades speed for
// altitude, roll banks the turn. Slow flight stalls; the ground bites.
const MAX_SPEED = 150, STALL_SPEED = 48, CEILING = 900;

function stepPhysics(dt) {
  const k = S.keys;
  let pitchIn = 0, rollIn = 0;
  if (k.pitchUp) pitchIn += 1;
  if (k.pitchDown) pitchIn -= 1;
  if (k.rollLeft) rollIn -= 1;
  if (k.rollRight) rollIn += 1;
  if (k.thrUp) S.throttle = clamp(S.throttle + dt * 0.5, 0, 1);
  if (k.thrDown) S.throttle = clamp(S.throttle - dt * 0.5, 0, 1);

  if (S.autopilot) {
    // Gentle autopilot: steer toward the next ring (or the runway when
    // the course is done), hold altitude, keep a cruise throttle.
    const target = S.courseComplete || S.ringIndex >= RINGS.length
      ? { x: 0, y: 45, z: 500 } : RINGS[S.ringIndex];
    const dx = target.x - S.x, dz = target.z - S.z;
    const wantHeading = Math.atan2(dx, dz);
    let dh = wantHeading - S.heading;
    while (dh > Math.PI) dh -= TAU;
    while (dh < -Math.PI) dh += TAU;
    rollIn = clamp(dh * 1.1, -0.7, 0.7);
    const wantAlt = target.y;
    pitchIn = clamp((wantAlt - S.y) * 0.008, -0.6, 0.6);
    S.throttle = lerp(S.throttle, 0.62, dt);
  } else if (S.mouseActive && S.phase === PHASE_FLY) {
    // Mouse steers: horizontal offset banks, vertical offset pitches.
    rollIn += clamp(S.mouseX * 1.4, -1, 1) * 0.55;
    pitchIn += clamp(-S.mouseY * 1.2, -1, 1) * 0.4;
  }

  // Smooth the attitude toward the inputs.
  const targetRoll = clamp(rollIn, -1, 1) * 0.85;
  S.roll = lerp(S.roll, targetRoll, 1 - Math.exp(-dt * 3.2));
  const targetPitch = clamp(pitchIn, -1, 1) * 0.42;
  S.pitch = lerp(S.pitch, targetPitch, 1 - Math.exp(-dt * 2.6));

  // Speed: throttle pulls toward its target; drag grows with speed.
  const targetSpeed = 30 + S.throttle * (MAX_SPEED - 30);
  S.speed = lerp(S.speed, targetSpeed, 1 - Math.exp(-dt * 0.55));
  S.speed -= Math.sin(S.pitch) * 14 * dt; // climbing costs speed
  S.speed = clamp(S.speed, 18, MAX_SPEED + 20);

  // Banked turn: heading follows the roll.
  S.heading += -Math.sin(S.roll) * 0.55 * (S.speed / 90) * dt;

  // Vertical speed from pitch and lift; a stall sinks the nose.
  const stalled = S.speed < STALL_SPEED;
  let vs = Math.sin(S.pitch) * S.speed;
  if (stalled) vs -= (STALL_SPEED - S.speed) * 1.6;
  // Slow flight sinks: throttle back to descend, throttle up to hold
  // altitude. This is what makes a landing approach possible.
  if (S.speed < 70) vs -= (70 - S.speed) * 0.09;
  // Ground effect: the air cushions the last metres, so a shallow
  // approach flares instead of slamming in.
  const aglNow = S.y - terrainHeight(S.x, S.z);
  if (aglNow < 12 && vs < 0) vs *= 0.55;
  S.vs = vs;
  S.y += vs * dt;
  S.x += Math.sin(S.heading) * Math.cos(S.pitch) * S.speed * dt;
  S.z += Math.cos(S.heading) * Math.cos(S.pitch) * S.speed * dt;

  // Soft world bounds.
  if (S.x < WORLD.xMin + 100) { S.x = WORLD.xMin + 100; S.heading = Math.abs(S.heading) < Math.PI / 2 ? S.heading : -S.heading; }
  if (S.x > WORLD.xMax - 100) { S.x = WORLD.xMax - 100; S.heading = Math.abs(S.heading) < Math.PI / 2 ? S.heading : -S.heading; }
  if (S.z < 40) { S.z = 40; S.heading = Math.PI - S.heading; }
  if (S.z > WORLD.zMax) { S.z = WORLD.zMax; S.heading = Math.PI - S.heading; }
  if (S.y > CEILING) { S.y = CEILING; S.pitch = Math.min(S.pitch, 0); }

  S.warn = '';
  if (stalled && S.phase === PHASE_FLY) S.warn = 'STALL — throttle up, nose down';
  const ground = terrainHeight(S.x, S.z);
  const agl = S.y - ground;
  if (agl < 45 && S.vs < -6 && S.phase === PHASE_FLY) S.warn = 'PULL UP — terrain!';

  // Rings: crossing the ring's plane inside its radius scores.
  if (S.ringIndex < RINGS.length) {
    const ring = RINGS[S.ringIndex];
    const prevZ = S.z - Math.cos(S.heading) * Math.cos(S.pitch) * S.speed * dt;
    const crossed = (prevZ - ring.z) * (S.z - ring.z) <= 0 && S.z > prevZ;
    if (crossed) {
      const dxr = S.x - ring.x, dyr = S.y - ring.y;
      if (Math.hypot(dxr, dyr) < ring.r) {
        S.ringsHit++;
        const bonus = 100 + Math.max(0, Math.round(50 - S.flightTime * 0.15));
        S.score += bonus;
        S.ringIndex++;
        ringChime();
        if (S.ringIndex >= RINGS.length) {
          S.courseComplete = true;
          showMessage('COURSE COMPLETE — land on the runway!  +' + bonus, 3);
        } else {
          showMessage('RING ' + S.ringsHit + '/8  +' + bonus, 2);
        }
      }
    }
  }

  // Ground contact.
  if (S.y <= ground + 1.2) {
    const onRunway = S.x > RUNWAY.x0 && S.x < RUNWAY.x1 &&
                     S.z > RUNWAY.z0 && S.z < RUNWAY.z1;
    const gentle = S.vs > -6 && Math.abs(S.roll) < 0.25 && S.speed < 95;
    if (onRunway && gentle) {
      S.y = ground + 1.2;
      S.phase = PHASE_LAND;
      S.landBonus = 250 + (S.courseComplete ? 500 : 0);
      S.score += S.landBonus;
      showMessage('', 0);
    } else {
      S.phase = PHASE_CRASH;
      S.crashReason = onRunway
        ? 'Too fast / too steep for the runway'
        : (agl < 1.2 && S.vs < -12 ? 'You flew into the terrain' : 'You hit the ground');
      if (S.speed > 100) S.crashReason = 'You hit the terrain at speed';
      crashSound();
    }
  }
  if (S.y < 0.5) S.y = 0.5;
}

// ---------------------------------------------------------------- camera
// Chase camera trails behind and above the plane; cockpit sits at the nose.
function updateCamera(dt) {
  const fx = Math.sin(S.heading), fz = Math.cos(S.heading);
  if (S.view === VIEW_CHASE) {
    const back = 26, up = 7;
    const tx = S.x - fx * back, ty = S.y + up, tz = S.z - fz * back;
    const k = 1 - Math.exp(-dt * 5);
    S.camX = lerp(S.camX || tx, tx, k);
    S.camY = lerp(S.camY || ty, ty, k);
    S.camZ = lerp(S.camZ || tz, tz, k);
    S.camYaw = S.heading; S.camPitch = S.pitch * 0.55; S.camRoll = S.roll * 0.55;
  } else {
    S.camX = S.x + fx * 2.2; S.camY = S.y + 1.1; S.camZ = S.z + fz * 2.2;
    S.camYaw = S.heading; S.camPitch = S.pitch; S.camRoll = S.roll;
  }
}

// Project a world point to screen space; null when behind the camera.
const FOV = 72 * DEG;
function project(px, py, pz) {
  const dx = px - S.camX, dy = py - S.camY, dz = pz - S.camZ;
  const sy = Math.sin(S.camYaw), cy = Math.cos(S.camYaw);
  const cx0 = dx * cy - dz * sy;      // right
  const cy0 = dy;                     // up
  const cz0 = dx * sy + dz * cy;      // forward
  const sp = Math.sin(S.camPitch), cp = Math.cos(S.camPitch);
  const y1 = cy0 * cp - cz0 * sp;
  const z1 = cy0 * sp + cz0 * cp;
  const sr = Math.sin(-S.camRoll), cr = Math.cos(-S.camRoll);
  const x2 = cx0 * cr - y1 * sr;
  const y2 = cx0 * sr + y1 * cr;
  if (z1 < 2) return null;
  const f = (H / 2) / Math.tan(FOV / 2);
  return { x: W / 2 + (x2 / z1) * f, y: H / 2 - (y2 / z1) * f, d: z1, s: f / z1 };
}

// ---------------------------------------------------------------- render
// Sky: gradient, sun with glow, and drifting clouds (fixed world spots).
const CLOUDS = [];
for (let i = 0; i < 26; i++) {
  CLOUDS.push({
    x: -3600 + rng() * 7200, y: 380 + rng() * 220, z: 400 + rng() * 11000,
    r: 80 + rng() * 150, a: 0.4 + rng() * 0.3,
  });
}
const SUN_DIR = { x: 0.45, y: 0.62, z: 0.65 };

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2f6fd0');
  g.addColorStop(0.45, '#7fb2e8');
  g.addColorStop(0.72, '#cfe6f7');
  g.addColorStop(1, '#e8f3fb');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Sun.
  const sunP = project(
    S.camX + SUN_DIR.x * 9000, S.camY + SUN_DIR.y * 9000, S.camZ + SUN_DIR.z * 9000);
  if (sunP) {
    const rg = ctx.createRadialGradient(sunP.x, sunP.y, 4, sunP.x, sunP.y, 180);
    rg.addColorStop(0, 'rgba(255,246,200,0.95)');
    rg.addColorStop(0.25, 'rgba(255,226,140,0.55)');
    rg.addColorStop(1, 'rgba(255,226,140,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(sunP.x - 180, sunP.y - 180, 360, 360);
    ctx.fillStyle = '#fff7d6';
    ctx.beginPath(); ctx.arc(sunP.x, sunP.y, 26, 0, TAU); ctx.fill();
  }
}

// Terrain colour by height, patch and slope; fog blends to the horizon.
// Water only inside the lake basin, and the runway's flattened apron is
// airfield grass — never a moat of water or sand around the strip.
function terrainColor(h, x, z, dist) {
  let r, g, b;
  const apron = runwayBlend(x, z);
  if (apron > 0.25) { r = 118; g = 158; b = 72; }              // airfield grass
  else if (h < 0.5 && lakeFactor(x, z) > 0.25) { r = 62; g = 132; b = 178; } // lake
  else if (h < 1.5) { r = 216; g = 196; b = 150; }            // sand / shore
  else if (h < 30) {                                     // valley fields
    // Smoothly blend between two field greens by noise (no hard squares).
    const t = vnoise(x * 0.0012 + 7, z * 0.0012 + 3);
    const g1 = [132, 170, 78], g2 = [102, 150, 70];
    const g3 = [158, 176, 92];
    const m = t < 0.5 ? lerp(g1[0], g2[0], t * 2) : lerp(g2[0], g3[0], (t - 0.5) * 2);
    const n2 = t < 0.5 ? lerp(g1[1], g2[1], t * 2) : lerp(g2[1], g3[1], (t - 0.5) * 2);
    const b2 = t < 0.5 ? lerp(g1[2], g2[2], t * 2) : lerp(g2[2], g3[2], (t - 0.5) * 2);
    r = m; g = n2; b = b2;
  } else if (h < 70) { r = 96; g = 132; b = 66; }        // forested hills
  else if (h < 115) { r = 128; g = 110; b = 82; }        // rock
  else if (h < 165) { r = 148; g = 138; b = 128; }       // high rock
  else { r = 244; g = 247; b = 252; }                    // snow
  // Texture + fog.
  const n = 0.97 + vnoise(x * 0.05, z * 0.05) * 0.03;
  const fog = clamp(dist / 9000, 0, 0.72);
  const fr = 207, fg = 230, fb = 247;
  r = lerp(r * n, fr, fog); g = lerp(g * n, fg, fog); b = lerp(b * n, fb, fog);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function drawTerrain() {
  const fx = Math.sin(S.camYaw), fz = Math.cos(S.camYaw);
  const rx = Math.cos(S.camYaw), rz = -Math.sin(S.camYaw);
  // Grid in camera space: lateral steps and forward steps (growing).
  const LAT = 18, FWD = 22;
  const latStep = 110;
  const dists = [];
  let d = 30;
  for (let i = 0; i < FWD; i++) { dists.push(d); d = d * 1.28 + 26; }
  // Precompute projected points.
  const pts = [];
  for (let j = 0; j < FWD; j++) {
    const row = [];
    for (let i = -LAT; i <= LAT; i++) {
      const lat = i * latStep * (1 + dists[j] / 2600); // widen with distance
      const wx = S.camX + fx * dists[j] + rx * lat;
      const wz = S.camZ + fz * dists[j] + rz * lat;
      const wy = terrainHeight(wx, wz);
      row.push({ p: project(wx, wy, wz), h: wy, x: wx, z: wz, d: dists[j] });
    }
    pts.push(row);
  }
  // Painter's order: far rows first.
  for (let j = FWD - 2; j >= 0; j--) {
    for (let i = 0; i < pts[j].length - 1; i++) {
      const a = pts[j][i], b = pts[j][i + 1];
      const c = pts[j + 1][i + 1], e = pts[j + 1][i];
      if (!a.p || !b.p || !c.p || !e.p) continue;
      const hAvg = (a.h + b.h + c.h + e.h) / 4;
      const xAvg = (a.x + b.x + c.x + e.x) / 4;
      const zAvg = (a.z + b.z + c.z + e.z) / 4;
      ctx.fillStyle = terrainColor(hAvg, xAvg, zAvg, (a.d + e.d) / 2);
      ctx.beginPath();
      ctx.moveTo(a.p.x, a.p.y); ctx.lineTo(b.p.x, b.p.y);
      ctx.lineTo(c.p.x, c.p.y); ctx.lineTo(e.p.x, e.p.y);
      ctx.closePath(); ctx.fill();
    }
  }
}

function drawClouds() {
  ctx.save();
  for (const c of CLOUDS) {
    const p = project(c.x, c.y, c.z);
    if (!p || p.x < -400 || p.x > W + 400 || p.y < -200 || p.y > H * 0.75) continue;
    const s = p.s * c.r;
    if (s < 4) continue;
    ctx.fillStyle = `rgba(255,255,255,${(c.a * clamp(1.4 - p.d / 12000, 0.25, 1)).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, s, s * 0.36, 0, 0, TAU);
    ctx.ellipse(p.x - s * 0.55, p.y + s * 0.08, s * 0.62, s * 0.28, 0, 0, TAU);
    ctx.ellipse(p.x + s * 0.55, p.y + s * 0.06, s * 0.66, s * 0.3, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// Runway: asphalt strip with centreline dashes, threshold bars and edge
// lights, drawn over the flattened terrain.
function drawRunway() {
  const strip = [];
  const segs = 26;
  for (let i = 0; i <= segs; i++) {
    const z = RUNWAY.z0 + ((RUNWAY.z1 - RUNWAY.z0) * i) / segs;
    strip.push({
      l: project(RUNWAY.x0, 0.4, z),
      r: project(RUNWAY.x1, 0.4, z),
      z,
    });
  }
  for (let i = 0; i < segs; i++) {
    const a = strip[i], b = strip[i + 1];
    if (!a.l || !a.r || !b.l || !b.r) continue;
    ctx.fillStyle = i % 2 ? '#3a3f46' : '#34383f';
    ctx.beginPath();
    ctx.moveTo(a.l.x, a.l.y); ctx.lineTo(a.r.x, a.r.y);
    ctx.lineTo(b.r.x, b.r.y); ctx.lineTo(b.l.x, b.l.y);
    ctx.closePath(); ctx.fill();
  }
  // Centreline dashes.
  ctx.fillStyle = '#f4f6f8';
  for (let i = 0; i < segs; i += 2) {
    const z0 = RUNWAY.z0 + ((RUNWAY.z1 - RUNWAY.z0) * i) / segs;
    const z1 = RUNWAY.z0 + ((RUNWAY.z1 - RUNWAY.z0) * (i + 0.8)) / segs;
    const p0 = project(-2.5, 0.7, z0), p1 = project(2.5, 0.7, z0);
    const p2 = project(2.5, 0.7, z1), p3 = project(-2.5, 0.7, z1);
    if (!p0 || !p1 || !p2 || !p3) continue;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y);
    ctx.closePath(); ctx.fill();
  }
  // Edge lights (amber, every ~60 m), capped so near ones stay small.
  for (let z = RUNWAY.z0 + 20; z < RUNWAY.z1; z += 60) {
    for (const x of [RUNWAY.x0 - 4, RUNWAY.x1 + 4]) {
      const p = project(x, 1.2, z);
      if (!p || p.d < 40) continue;
      const r = clamp(p.s * 1.4, 1.5, 7);
      ctx.fillStyle = '#ffb020';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
    }
  }
}

// Rings: glowing torus rings; the next one is gold, the rest cyan.
function drawRings() {
  for (let i = S.ringIndex; i < RINGS.length; i++) {
    const ring = RINGS[i];
    const p = project(ring.x, ring.y, ring.z);
    if (!p) continue;
    const isNext = i === S.ringIndex;
    const pr = project(ring.x + ring.r, ring.y, ring.z);
    const rad = pr ? Math.abs(pr.x - p.x) : p.s * ring.r;
    if (rad < 2 || p.x < -300 || p.x > W + 300) continue;
    ctx.save();
    ctx.globalAlpha = clamp(1.15 - p.d / 9000, 0.25, 1);
    ctx.strokeStyle = isNext ? '#ffc21a' : '#37e0e6';
    ctx.lineWidth = Math.max(2, rad * 0.09);
    ctx.shadowColor = isNext ? '#ffb020' : '#19b8c4';
    ctx.shadowBlur = isNext ? 26 : 14;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rad, rad * 0.96, 0, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Label only the next ring, or a ring close enough to read.
    if (isNext || p.d < 2600) {
      ctx.fillStyle = isNext ? '#ffe9a8' : '#d9fbff';
      ctx.font = `700 ${Math.max(11, Math.min(22, rad * 0.22)) | 0}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(isNext ? 'NEXT' : 'R' + (i + 1), p.x, p.y - rad - 8);
    }
    ctx.restore();
  }
}

// Next-ring pointer: an arrow at the screen edge when the ring is off-view.
function drawRingPointer() {
  if (S.ringIndex >= RINGS.length || S.phase !== PHASE_FLY) return;
  const ring = RINGS[S.ringIndex];
  const p = project(ring.x, ring.y, ring.z);
  const dist = Math.hypot(ring.x - S.x, ring.y - S.y, ring.z - S.z);
  if (p && p.x > 60 && p.x < W - 60 && p.y > 60 && p.y < H - 60) return;
  // Direction in screen space from the camera-forward bearing.
  const dx = ring.x - S.x, dz = ring.z - S.z;
  const rel = Math.atan2(dx, dz) - S.heading;
  const sx = Math.sin(rel), sy = -Math.cos(rel) * 0.4 - (ring.y - S.y) / 400;
  const ang = Math.atan2(sy, sx);
  const px = W / 2 + Math.cos(ang) * (Math.min(W, H) * 0.36);
  const py = H / 2 + Math.sin(ang) * (Math.min(W, H) * 0.36);
  ctx.save();
  ctx.translate(px, py); ctx.rotate(ang);
  ctx.fillStyle = '#ffc21a';
  ctx.beginPath();
  ctx.moveTo(16, 0); ctx.lineTo(-10, -11); ctx.lineTo(-4, 0); ctx.lineTo(-10, 11);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#ffe9a8';
  ctx.font = '700 15px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('RING ' + (S.ringIndex + 1) + '  ' + Math.round(dist) + ' m', px, py + 34);
}

// ---------------------------------------------------------------- aircraft
// Chase view: the plane from behind-above, banking with the roll.
function drawPlane() {
  if (S.view !== VIEW_CHASE) return;
  const cx = W / 2, cy = H * 0.66;
  const size = Math.min(W, H) / 5.2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(S.roll * 0.85);
  ctx.translate(0, S.pitch * size * 0.35);
  const t = S.time;
  const blink = Math.sin(t * 6) > 0;

  // Main wings.
  const wingGrad = ctx.createLinearGradient(0, -size * 0.1, 0, size * 0.1);
  wingGrad.addColorStop(0, '#f2f5f7'); wingGrad.addColorStop(1, '#c3ccd4');
  ctx.fillStyle = wingGrad;
  ctx.beginPath();
  ctx.moveTo(-size, size * 0.02);
  ctx.quadraticCurveTo(-size * 0.55, -size * 0.16, -size * 0.12, -size * 0.08);
  ctx.lineTo(size * 0.12, -size * 0.08);
  ctx.quadraticCurveTo(size * 0.55, -size * 0.16, size, size * 0.02);
  ctx.quadraticCurveTo(size * 0.5, size * 0.1, 0, size * 0.08);
  ctx.quadraticCurveTo(-size * 0.5, size * 0.1, -size, size * 0.02);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#8b98a5'; ctx.lineWidth = 1.5; ctx.stroke();
  // Wingtip stripes + nav lights.
  ctx.fillStyle = '#d23b2e';
  ctx.fillRect(-size * 0.99, -size * 0.06, size * 0.1, size * 0.1);
  ctx.fillRect(size * 0.89, -size * 0.06, size * 0.1, size * 0.1);
  if (blink) {
    ctx.fillStyle = '#37ff7a';
    ctx.beginPath(); ctx.arc(-size * 1.0, -size * 0.02, 4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ff4b3e';
    ctx.beginPath(); ctx.arc(size * 1.0, -size * 0.02, 4, 0, TAU); ctx.fill();
  }

  // Fuselage: tail (near, wide) to nose (far, narrow) — foreshortened,
  // so the plane reads as flying away from the camera, not standing up.
  const fusGrad = ctx.createLinearGradient(0, size * 0.42, 0, -size * 0.38);
  fusGrad.addColorStop(0, '#e8ecef'); fusGrad.addColorStop(0.6, '#ffffff');
  fusGrad.addColorStop(1, '#dfe5ea');
  ctx.fillStyle = fusGrad;
  ctx.beginPath();
  ctx.moveTo(-size * 0.17, size * 0.4);
  ctx.quadraticCurveTo(-size * 0.2, size * 0.08, -size * 0.1, -size * 0.28);
  ctx.quadraticCurveTo(0, -size * 0.4, size * 0.1, -size * 0.28);
  ctx.quadraticCurveTo(size * 0.2, size * 0.08, size * 0.17, size * 0.4);
  ctx.quadraticCurveTo(0, size * 0.47, -size * 0.17, size * 0.4);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#9aa6b1'; ctx.lineWidth = 1.5; ctx.stroke();
  // Red cheatline + cockpit hump.
  ctx.fillStyle = '#d23b2e';
  ctx.beginPath();
  ctx.moveTo(-size * 0.14, size * 0.26);
  ctx.quadraticCurveTo(-size * 0.11, -size * 0.02, -size * 0.06, -size * 0.2);
  ctx.lineTo(size * 0.06, -size * 0.2);
  ctx.quadraticCurveTo(size * 0.11, -size * 0.02, size * 0.14, size * 0.26);
  ctx.quadraticCurveTo(0, size * 0.31, -size * 0.14, size * 0.26);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#1d2f45';
  ctx.beginPath();
  ctx.ellipse(0, -size * 0.04, size * 0.09, size * 0.11, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(160,210,245,0.85)';
  ctx.beginPath();
  ctx.ellipse(-size * 0.02, -size * 0.07, size * 0.05, size * 0.06, 0, 0, TAU); ctx.fill();

  // Tailplane + fin.
  ctx.fillStyle = '#dfe5ea';
  ctx.beginPath();
  ctx.moveTo(-size * 0.42, size * 0.36);
  ctx.quadraticCurveTo(0, size * 0.29, size * 0.42, size * 0.36);
  ctx.quadraticCurveTo(size * 0.2, size * 0.43, 0, size * 0.43);
  ctx.quadraticCurveTo(-size * 0.2, size * 0.43, -size * 0.42, size * 0.36);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#9aa6b1'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = '#d23b2e';
  ctx.beginPath();
  ctx.moveTo(-size * 0.05, size * 0.4);
  ctx.lineTo(0, size * 0.58);
  ctx.lineTo(size * 0.05, size * 0.4);
  ctx.closePath(); ctx.fill();

  // Propeller at the nose: two spinning blades and a faint disc.
  const propA = t * 28;
  ctx.fillStyle = 'rgba(200,210,220,0.14)';
  ctx.beginPath(); ctx.ellipse(0, -size * 0.4, size * 0.22, size * 0.22, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(40,50,60,0.75)'; ctx.lineWidth = size * 0.04;
  ctx.lineCap = 'round';
  for (const a of [propA, propA + Math.PI]) {
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * size * 0.05, -size * 0.4 + Math.sin(a) * size * 0.05);
    ctx.lineTo(Math.cos(a) * size * 0.21, -size * 0.4 + Math.sin(a) * size * 0.21);
    ctx.stroke();
  }
  ctx.fillStyle = '#2c3a48';
  ctx.beginPath(); ctx.arc(0, -size * 0.4, size * 0.05, 0, TAU); ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- cockpit
// Cockpit view: dashboard with six lit round gauges, glareshield, pillars.
function drawGauge(cx, cy, r, label, valueText, frac, color) {
  ctx.save();
  ctx.translate(cx, cy);
  const face = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
  face.addColorStop(0, '#2a3a4a'); face.addColorStop(1, '#0d1620');
  ctx.fillStyle = face;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#5a6b7c'; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, r - 3, 0, TAU); ctx.stroke();
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI * 0.75 + (i / 10) * Math.PI * 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (r - 5), Math.sin(a) * (r - 5));
    ctx.lineTo(Math.cos(a) * (r - (i % 5 === 0 ? 12 : 8)), Math.sin(a) * (r - (i % 5 === 0 ? 12 : 8)));
    ctx.stroke();
  }
  const na = -Math.PI * 0.75 + clamp(frac, 0, 1) * Math.PI * 1.5;
  ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(na) * (r - 12), Math.sin(na) * (r - 12)); ctx.stroke();
  ctx.fillStyle = '#ffb020';
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill();
  ctx.fillStyle = '#cfe6ff';
  ctx.font = `700 ${Math.max(10, r * 0.32) | 0}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(valueText, 0, r * 0.52);
  ctx.fillStyle = '#8fb4d4';
  ctx.font = `600 ${Math.max(9, r * 0.24) | 0}px ui-monospace, Menlo, monospace`;
  ctx.fillText(label, 0, -r * 0.55);
  ctx.restore();
}

function drawCockpit() {
  if (S.view !== VIEW_COCKPIT) return;
  const panelH = H * 0.3;
  // Glareshield + dashboard.
  const pg = ctx.createLinearGradient(0, H - panelH, 0, H);
  pg.addColorStop(0, '#1a2530'); pg.addColorStop(1, '#0a121a');
  ctx.fillStyle = pg;
  ctx.beginPath();
  ctx.moveTo(0, H - panelH + 26);
  ctx.quadraticCurveTo(W / 2, H - panelH - 14, W, H - panelH + 26);
  ctx.lineTo(W, H); ctx.lineTo(0, H);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#3d4f61'; ctx.lineWidth = 2; ctx.stroke();
  // Nose + spinner at bottom centre.
  ctx.fillStyle = '#dfe5ea';
  ctx.beginPath();
  ctx.moveTo(W / 2 - 34, H); ctx.lineTo(W / 2 - 12, H - panelH + 34);
  ctx.lineTo(W / 2 + 12, H - panelH + 34); ctx.lineTo(W / 2 + 34, H);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#d23b2e';
  ctx.beginPath(); ctx.arc(W / 2, H - panelH + 30, 7, 0, TAU); ctx.fill();
  // Gauges.
  const gr = Math.min(W, H) * 0.052;
  const gy = H - panelH / 2 + 8;
  const spread = Math.min(W * 0.36, 560);
  const kt = Math.round(S.speed * 1.94);
  const altFt = Math.round(S.y * 3.28);
  const hdg = ((S.heading / DEG) % 360 + 360) % 360;
  drawGauge(W / 2 - spread, gy, gr, 'AIRSPEED', String(kt), clamp(S.speed / 150, 0, 1), '#37e0e6');
  drawGauge(W / 2 - spread * 0.55, gy, gr, 'ALTITUDE', String(altFt), clamp(S.y / 900, 0, 1), '#37e0e6');
  drawGauge(W / 2, gy, gr * 1.18, 'HEADING', String(Math.round(hdg)).padStart(3, '0'), hdg / 360, '#ffc21a');
  drawGauge(W / 2 + spread * 0.55, gy, gr, 'VERT SPD', (S.vs >= 0 ? '+' : '') + Math.round(S.vs * 3.28), clamp((S.vs + 15) / 30, 0, 1), '#37e0e6');
  drawGauge(W / 2 + spread, gy, gr, 'THROTTLE', Math.round(S.throttle * 100) + '%', S.throttle, '#ff9d2e');
  // Windshield pillars.
  ctx.fillStyle = '#101a24';
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(W * 0.045, 0); ctx.lineTo(W * 0.09, H - panelH);
  ctx.lineTo(0, H - panelH); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(W, 0); ctx.lineTo(W * 0.955, 0); ctx.lineTo(W * 0.91, H - panelH);
  ctx.lineTo(W, H - panelH); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.lineTo(W, H * 0.045); ctx.lineTo(0, H * 0.045);
  ctx.closePath(); ctx.fill();
}

// ---------------------------------------------------------------- HUD
function panel(x, y, w, h) {
  ctx.fillStyle = 'rgba(6,18,30,0.72)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,200,235,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawHUD() {
  const kt = Math.round(S.speed * 1.94);
  const altFt = Math.round(S.y * 3.28);
  const hdg = ((S.heading / DEG) % 360 + 360) % 360;
  ctx.textBaseline = 'alphabetic';

  // Altitude (top-left).
  panel(16, 14, 168, 88);
  ctx.fillStyle = '#8fb4d4';
  ctx.font = '600 12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('ALTITUDE  FT', 30, 36);
  ctx.fillStyle = '#eaf7ff';
  ctx.font = '700 30px ui-monospace, Menlo, monospace';
  ctx.fillText(String(altFt).padStart(5, ' '), 30, 68);
  ctx.fillStyle = S.vs >= 0 ? '#7dffb0' : '#ffb020';
  ctx.font = '600 13px ui-monospace, Menlo, monospace';
  ctx.fillText((S.vs >= 0 ? '▲ +' : '▼ ') + Math.round(Math.abs(S.vs * 3.28)) + ' fpm', 30, 90);

  // Speed (top-right) + throttle bar.
  panel(W - 184, 14, 168, 88);
  ctx.fillStyle = '#8fb4d4';
  ctx.font = '600 12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.fillText('AIRSPEED  KT', W - 30, 36);
  ctx.fillStyle = '#eaf7ff';
  ctx.font = '700 30px ui-monospace, Menlo, monospace';
  ctx.fillText(String(kt), W - 30, 68);
  ctx.fillStyle = '#ff9d2e';
  ctx.fillRect(W - 164, 80, 128 * S.throttle, 6);
  ctx.strokeStyle = 'rgba(120,200,235,0.4)';
  ctx.strokeRect(W - 164, 80, 128, 6);
  ctx.fillStyle = '#8fb4d4';
  ctx.font = '600 11px ui-monospace, Menlo, monospace';
  ctx.fillText('THR ' + Math.round(S.throttle * 100) + '%', W - 30, 98);

  // Compass tape (top-centre). Ticks every 5°, labels every 30° of
  // absolute heading (computed from the heading itself, not the ticks,
  // so labels show at any heading).
  const tapeW = Math.min(420, W * 0.42), tapeX = (W - tapeW) / 2;
  panel(tapeX, 14, tapeW, 44);
  ctx.save();
  ctx.beginPath(); ctx.rect(tapeX, 14, tapeW, 44); ctx.clip();
  const pxPerDeg = tapeW / 120;
  for (let d = -60; d <= 60; d += 5) {
    const a = hdg + d;
    const near30 = Math.abs((((a % 30) + 30) % 30) - 0) < 2.6 ||
                   Math.abs((((a % 30) + 30) % 30) - 30) < 2.6;
    const x = tapeX + tapeW / 2 + d * pxPerDeg;
    const isCard = Math.abs((((a % 90) + 90) % 90) - 0) < 2.6 ||
                   Math.abs((((a % 90) + 90) % 90) - 90) < 2.6;
    ctx.strokeStyle = isCard ? '#ffc21a' : 'rgba(180,220,245,0.6)';
    ctx.lineWidth = isCard ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 22); ctx.lineTo(x, near30 ? 34 : 28); ctx.stroke();
  }
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let k = -2; k <= 2; k++) {
    const lab = Math.round(hdg / 30) * 30 + k * 30;
    let rel = ((lab - hdg + 540) % 360) - 180;
    if (Math.abs(rel) > 58) continue;
    const x = tapeX + tapeW / 2 + rel * pxPerDeg;
    const aa = ((lab % 360) + 360) % 360;
    const isCard = aa % 90 === 0;
    ctx.fillStyle = isCard ? '#ffc21a' : '#ffffff';
    ctx.font = '700 15px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(names[aa] || String(aa).padStart(3, '0'), x, 50);
  }
  ctx.restore();
  ctx.fillStyle = '#ffc21a';
  ctx.beginPath();
  ctx.moveTo(W / 2 - 7, 14); ctx.lineTo(W / 2 + 7, 14); ctx.lineTo(W / 2, 24);
  ctx.closePath(); ctx.fill();

  // Artificial horizon — right of the score panel, clear of it.
  const ahX = 272, ahY = H - 54, ahR = 38;
  ctx.save();
  ctx.beginPath(); ctx.arc(ahX, ahY, ahR, 0, TAU); ctx.clip();
  ctx.translate(ahX, ahY);
  ctx.rotate(-S.roll);
  ctx.translate(0, S.pitch * ahR * 1.4);
  ctx.fillStyle = '#3d7ec2'; ctx.fillRect(-ahR, -ahR, ahR * 2, ahR);
  ctx.fillStyle = '#8a6a42'; ctx.fillRect(-ahR, 0, ahR * 2, ahR);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-ahR, 0); ctx.lineTo(ahR, 0); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#cfe6ff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(ahX, ahY, ahR, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#ffc21a';
  ctx.beginPath(); ctx.moveTo(ahX - 16, ahY); ctx.lineTo(ahX - 4, ahY); ctx.lineTo(ahX, ahY - 4);
  ctx.lineTo(ahX + 4, ahY); ctx.lineTo(ahX + 16, ahY); ctx.lineTo(ahX + 4, ahY + 3);
  ctx.lineTo(ahX - 4, ahY + 3); ctx.closePath(); ctx.fill();

  // Score + rings (bottom-left).
  panel(16, H - 92, 210, 76);
  ctx.fillStyle = '#8fb4d4';
  ctx.font = '600 12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('SCORE', 30, H - 70);
  ctx.fillStyle = '#eaf7ff';
  ctx.font = '700 26px ui-monospace, Menlo, monospace';
  ctx.fillText(String(S.score), 30, H - 40);
  ctx.fillStyle = '#8fb4d4';
  ctx.font = '600 12px ui-monospace, Menlo, monospace';
  ctx.fillText('RINGS ' + S.ringsHit + '/8', 118, H - 70);
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i < S.ringsHit ? '#ffc21a' : 'rgba(160,200,230,0.35)';
    ctx.beginPath(); ctx.arc(124 + i * 13, H - 48, 4.5, 0, TAU); ctx.fill();
  }
  const mm = String(Math.floor(S.flightTime / 60)).padStart(2, '0');
  const ss = String(Math.floor(S.flightTime % 60)).padStart(2, '0');
  ctx.fillStyle = '#8fb4d4';
  ctx.fillText('TIME ' + mm + ':' + ss, 118, H - 28);

  // Controls hint (bottom-right).
  ctx.fillStyle = 'rgba(6,18,30,0.5)';
  ctx.font = '600 12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.fillText('ARROWS/WASD fly · SHIFT/CTRL throttle · MOUSE steer · C view · P pause · R restart', W - 16, H - 16);

  // Warnings + centre message.
  if (S.warn) {
    ctx.fillStyle = Math.sin(S.time * 10) > 0 ? '#ff5b4d' : '#ffb020';
    ctx.font = '700 22px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(S.warn, W / 2, H * 0.3);
  }
  if (S.messageT > 0 && S.message) {
    ctx.globalAlpha = clamp(S.messageT, 0, 1);
    ctx.fillStyle = '#ffe9a8';
    ctx.font = '700 26px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(S.message, W / 2, H * 0.22);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- overlays
function drawTitle() {
  ctx.fillStyle = 'rgba(4,14,26,0.45)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${Math.min(84, W * 0.07) | 0}px ui-monospace, Menlo, monospace`;
  ctx.fillText('RIDGE RUNNER', W / 2, H * 0.3);
  ctx.fillStyle = '#ffc21a';
  ctx.font = `600 ${Math.min(22, W * 0.02) | 0}px ui-monospace, Menlo, monospace`;
  ctx.fillText('FLY THE VALLEY · THREAD THE RINGS · LAND THE RUNWAY', W / 2, H * 0.3 + 44);
  ctx.fillStyle = '#d9ecfa';
  ctx.font = '600 17px ui-monospace, Menlo, monospace';
  const lines = [
    'ARROWS / WASD — pitch and roll      SHIFT / CTRL — throttle',
    'MOUSE — steer                       C — cockpit / chase view',
    '8 glowing rings to fly through, then land on the runway.',
    'Throttle back to sink onto the runway. Stall below 48 kt.',
  ];
  lines.forEach((ln, i) => ctx.fillText(ln, W / 2, H * 0.46 + i * 30));
  ctx.fillStyle = Math.sin(S.time * 4) > 0 ? '#ffe9a8' : '#cfe6ff';
  ctx.font = '700 24px ui-monospace, Menlo, monospace';
  ctx.fillText('PRESS ENTER OR CLICK TO FLY', W / 2, H * 0.68);
}

function drawEnd() {
  ctx.fillStyle = 'rgba(4,14,26,0.55)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  if (S.phase === PHASE_CRASH) {
    ctx.fillStyle = '#ff6b5e';
    ctx.font = `800 ${Math.min(64, W * 0.055) | 0}px ui-monospace, Menlo, monospace`;
    ctx.fillText('CRASHED', W / 2, H * 0.38);
    ctx.fillStyle = '#ffe9a8';
    ctx.font = '600 20px ui-monospace, Menlo, monospace';
    ctx.fillText(S.crashReason, W / 2, H * 0.38 + 40);
  } else {
    ctx.fillStyle = '#7dffb0';
    ctx.font = `800 ${Math.min(64, W * 0.055) | 0}px ui-monospace, Menlo, monospace`;
    ctx.fillText(S.courseComplete ? 'COURSE COMPLETE!' : 'LANDED!', W / 2, H * 0.38);
    ctx.fillStyle = '#ffe9a8';
    ctx.font = '600 20px ui-monospace, Menlo, monospace';
    ctx.fillText('Landing bonus +' + S.landBonus, W / 2, H * 0.38 + 40);
  }
  ctx.fillStyle = '#fff';
  ctx.font = '700 30px ui-monospace, Menlo, monospace';
  ctx.fillText('SCORE  ' + S.score + '   ·   RINGS ' + S.ringsHit + '/8', W / 2, H * 0.52);
  ctx.fillStyle = Math.sin(S.time * 4) > 0 ? '#ffe9a8' : '#cfe6ff';
  ctx.font = '700 22px ui-monospace, Menlo, monospace';
  ctx.fillText('PRESS R OR ENTER TO FLY AGAIN', W / 2, H * 0.64);
}

function drawPaused() {
  ctx.fillStyle = 'rgba(4,14,26,0.5)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = '800 52px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('PAUSED', W / 2, H * 0.45);
  ctx.fillStyle = '#cfe6ff';
  ctx.font = '600 18px ui-monospace, Menlo, monospace';
  ctx.fillText('P to resume · R to restart', W / 2, H * 0.45 + 40);
}

// ---------------------------------------------------------------- main loop
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawSky();
  drawTerrain();
  drawRunway();
  drawClouds();
  drawRings();
  if (S.view === VIEW_CHASE) drawPlane();
  drawCockpit();
  if (S.phase !== PHASE_TITLE) drawHUD();
  drawRingPointer();
  if (S.phase === PHASE_TITLE) drawTitle();
  else if (S.phase === PHASE_CRASH || S.phase === PHASE_LAND) drawEnd();
  else if (S.phase === PHASE_PAUSE) drawPaused();
}

let lastNow = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = clamp((now - lastNow) / 1000 || 0.016, 0, 0.05);
  lastNow = now;
  S.time += dt;
  if (S.messageT > 0) S.messageT -= dt;
  if (S.phase === PHASE_FLY) {
    S.flightTime += dt;
    stepPhysics(dt);
  } else if (S.phase === PHASE_TITLE) {
    // Attract mode: the world flies itself behind the title.
    S.autopilot = true;
    stepPhysics(dt);
    S.autopilot = false;
    if (S.z > 9000 || S.ringIndex >= RINGS.length) {
      S.x = 0; S.y = 120; S.z = 300; S.heading = 0; S.ringIndex = 0; S.ringsHit = 0;
    }
  }
  updateCamera(dt);
  updateAudio();
  render();
}

// ---------------------------------------------------------------- shot mode
// ?shot=chase|cockpit|runway|rings stages a fixed, autopiloted view so a
// headless browser can capture a real render of the running game.
const params = new URLSearchParams(location.search);
const SHOTS = {
  chase: { view: VIEW_CHASE, x: 0, y: 195, z: 2100, heading: 0.12, speed: 120, throttle: 0.62, ring: 1 },
  cockpit: { view: VIEW_COCKPIT, x: 0, y: 55, z: 180, heading: 0, speed: 95, throttle: 0.55, ring: 0 },
  runway: { view: VIEW_CHASE, x: -10, y: 26, z: 120, heading: 0, speed: 88, throttle: 0.7, ring: 0 },
  rings: { view: VIEW_CHASE, x: -500, y: 170, z: 4400, heading: -0.8, speed: 125, throttle: 0.65, ring: 3 },
};
if (params.has('shot')) {
  const shot = SHOTS[params.get('shot')] || SHOTS.chase;
  S.shot = params.get('shot');
  S.view = shot.view;
  S.x = shot.x; S.y = shot.y; S.z = shot.z;
  S.heading = shot.heading; S.speed = shot.speed; S.throttle = shot.throttle;
  S.ringIndex = shot.ring; S.ringsHit = shot.ring;
  S.phase = PHASE_FLY;
  S.autopilot = true;
  S.mouseActive = false;
} else {
  // Title attract: start mid-valley, autopilot flies the course.
  S.x = 0; S.y = 120; S.z = 300; S.speed = 110; S.throttle = 0.6;
}

// Debug handle: lets a play-test (or a curious pilot) read the live state.
window.__ridge = S;

requestAnimationFrame(frame);
