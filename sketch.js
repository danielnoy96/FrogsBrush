// ===============================
// Cars & Frogs — PNG animations (pixel art)
// Horizontal drag => cars
// Vertical drag   => frogs
//
// UI (menu bar):
// - Mode: ANIMATE / STILL
// - Brush slider (frog burst count)
// - Clear Canvas button
// - Eraser toggle (drag removes items)
//
// BLOOD:
// - On squish: spray + floor splat
// - Blood fades out after 5 seconds
//
// AMBULANCES (UPDATED):
// - NO threshold anymore.
// - Every time a frog is crushed, schedule exactly ONE ambulance for that frog.
// - Ambulance spawns 0.5s (500ms) after the crash.
// - Ambulances still avoid overlapping + have stuck-fix steering.
//
// CRASH (FIXED):
// - car_crash_0 shown at start
// - pick variant once (up/down) via wobble slip sign
// - show car_crash_1u/1d
// - split: car uses car_crash_3u/3d, frog-piece uses car_crash_2u/2d
// - frog-piece falls to a LOCAL ground then slides to stop (not flying offscreen)
//
// NEW:
// - crashPieces get picked up by Ambulance (same system) and disappear by being carried out
// - wrecked Cars get picked up by TowTruck (car_grar.png) and disappear by being towed out
// ===============================

let cars = [];
let frogs = [];
let bloodSplats = [];
let ambulances = [];
let crashPieces = [];
let towTrucks = [];

let GFX = {};
let lastSpawnPos;

let creationCounter = 0;

// chain crash detection
let prevSegSpeed = 0;
let chainCooldown = 0;
let fastFrames = 0;
let stoppedFrames = 0;

// --- MODE ---
let MODE = "animate"; // "animate" | "still"

// --- ERASER ---
let ERASER = false;

// UI elements
let uiBar;
let modeBtn;
let clearBtn;
let eraserBtn;

let brushSlider, brushLabel;

const UI_BAR_H = 46;

// Global upscale (makes *everything* bigger: frogs, cars, blood, ambulances, etc.)
const WORLD_SCALE = 1.6;
function U(v) { return Math.round(v * WORLD_SCALE); }   // lengths (px-ish)
function UF(v) { return v * WORLD_SCALE; }              // speeds/accelerations (float)

// Tuning (scaled)
const FROG_RENDER_SIZE = U(60);
const FROG_HIT_RADIUS = U(14);
// Prevent "accidental piling" during a single drag:
// - spawn spacing is larger than the "stack" radius
// - stacking only happens when intentionally very close
const FROG_SPAWN_MIN_DIST = Math.max(8, Math.round(FROG_RENDER_SIZE * 0.32));
const FROG_STACK_NEAR_RADIUS = Math.round(FROG_RENDER_SIZE * 0.18);

const CAR_RENDER_SIZE = U(60);
const CAR_BODY_W = U(70);
const CAR_BODY_H = U(70);
const CAR_SPAWN_MIN_DIST = Math.round(CAR_BODY_W * 0.55);

const CRASH_PIECE_SIZE = U(70);
const AMBULANCE_RENDER_SIZE = U(60);
const TOW_TRUCK_RENDER_SIZE = U(72);

const ERASER_RADIUS = U(38);
const BLOOD_SPRAY_HIT_RADIUS = U(50);
const OFFSCREEN_PAD = U(250);
const WORLD_EDGE_PAD_Y = U(60);

function clampWorldY(y) {
  const pad = min(WORLD_EDGE_PAD_Y, floor(height * 0.5));
  return constrain(y, pad, height - pad);
}

// Evasion tuning (helps frogs dodge before contact)
const FROG_EVADE_LEAD_FRAMES = 9;           // how many frames ahead frogs "look"
const FROG_EVADE_BASE_WARN_X = U(40);       // minimum x distance to trigger evade
const FROG_EVADE_WARN_Y = U(44);            // y proximity to consider a threat
const FROG_EVADE_COOLDOWN_FRAMES = 16;      // prevent repeated evade triggers

// Blood pixel-art rendering
const BLOOD_PIXEL_SCALE = 8; // higher = chunkier pixels
let bloodLayer = null;

function ensureBloodLayer() {
  // Use integer upscaling (no fractional stretch) to keep pixels perfectly square.
  const w = max(1, ceil(width / BLOOD_PIXEL_SCALE));
  const h = max(1, ceil(height / BLOOD_PIXEL_SCALE));
  if (bloodLayer && bloodLayer.width === w && bloodLayer.height === h) return;
  bloodLayer = createGraphics(w, h);
  bloodLayer.pixelDensity(1);
  bloodLayer.noSmooth();
}

function postProcessBloodLayer() {
  if (!bloodLayer) return;
  const w = bloodLayer.width;

  bloodLayer.loadPixels();
  const pix = bloodLayer.pixels;

  const alphaCut = 24;
  const br = 140, bg = 20, bb = 30;

  // 4x4 Bayer matrix for hard-pixel alpha dithering (keeps pixels crisp, avoids halos).
  const bayer4 = [
    0,  8,  2, 10,
    12, 4, 14, 6,
    3, 11,  1,  9,
    15, 7, 13, 5
  ];

  // Force a single red color and convert soft edges into hard pixels (no highlights / no grey/white borders).
  for (let i = 0, p = 0; i < pix.length; i += 4, p++) {
    const a = pix[i + 3];
    if (a <= alphaCut) {
      pix[i + 3] = 0;
      continue;
    }

    const x = p % w;
    const y = (p / w) | 0;
    const t = (bayer4[(x & 3) + ((y & 3) << 2)] + 1) / 16;
    if ((a / 255) < t) {
      pix[i + 3] = 0;
      continue;
    }

    pix[i + 0] = br;
    pix[i + 1] = bg;
    pix[i + 2] = bb;
    pix[i + 3] = 255;
  }

  bloodLayer.updatePixels();
}

// -------------------------
// Blood fade settings
// -------------------------
const BLOOD_FADE_START_MS = 5000; // start fading after 5 seconds
const BLOOD_FADE_DUR_MS   = 1400; // fade duration

// -------------------------
// Ambulance settings (UPDATED)
// -------------------------
const AMBULANCE_SPAWN_DELAY_MS = 500;   // half a second after crash
const AMBULANCE_PICKUP_DIST = U(18);
const AMBULANCE_SPAWN_EDGE_PAD = U(90);

// anti-overlap steering
const AMBULANCE_SEP_RADIUS = U(54);
const AMBULANCE_SEP_FORCE  = 0.22;
const AMBULANCE_MAX_SEP    = 0.45;

// stuck detector
const AMBULANCE_STUCK_FRAMES = 26;
const AMBULANCE_PROGRESS_EPS = UF(0.55);

// -------------------------
// Tow settings
// -------------------------
const TOW_SPAWN_DELAY_MS = 700;
const TOW_PICKUP_DIST = U(20);
const TOW_SPAWN_EDGE_PAD = U(110);

// -------------------------
// Animation helper
// -------------------------
class Animation {
  constructor(frames, fps = 12, loop = true) {
    this.frames = frames;
    this.fps = fps;
    this.loop = loop;
    this.t = 0;
    this.done = false;
  }
  reset() { this.t = 0; this.done = false; }
  update() {
    if (this.done) return;
    this.t += deltaTime / 1000;
    const total = this.frames.length / this.fps;
    if (!this.loop && this.t >= total) this.done = true;
  }
  frame() {
    if (!this.frames || this.frames.length === 0) return null;
    let idx = floor(this.t * this.fps);
    if (this.loop) idx = idx % this.frames.length;
    else idx = min(idx, this.frames.length - 1);
    return this.frames[idx];
  }
  progress01() {
    const dur = this.frames.length / this.fps;
    if (dur <= 0) return 1;
    return constrain(this.t / dur, 0, 1);
  }
}

function loadFrames(prefix, count) {
  const arr = [];
  for (let i = 0; i < count; i++) arr.push(loadImage(`${prefix}_${i}.png`));
  return arr;
}

// --- Transparency helper: remove near-white background (chroma key) ---
function keyOutNearWhite(img, threshold = 18) {
  if (!img) return;
  img.loadPixels();
  const p = img.pixels;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i + 0], g = p[i + 1], b = p[i + 2], a = p[i + 3];
    if (a === 0) continue;
    if (r >= 255 - threshold && g >= 255 - threshold && b >= 255 - threshold) p[i + 3] = 0;
  }
  img.updatePixels();
}

function preprocessJumpFrames() {
  if (!GFX.frogJump || GFX.frogJump.length === 0) return;
  for (const fr of GFX.frogJump) keyOutNearWhite(fr, 18);
}

// -------------------------
// preload / setup / draw
// -------------------------
function preload() {
  GFX.frogIdle = loadFrames("frog_idle", 1);
  GFX.frogJump = loadFrames("frog_jump", 6); // 0-2 up, 3-5 down
  GFX.frogSquish = loadFrames("frog_squish", 1);
  GFX.frogPile = loadFrames("frog_pile", 5);

  GFX.carDrive = loadFrames("car_drive", 1);
  GFX.carCrash = loadFrames("car_crash", 3);

  // crash branching frames
  GFX.carCrash0  = loadImage("car_crash_0.png");
  GFX.carCrash1u = loadImage("car_crash_1u.png");
  GFX.carCrash1d = loadImage("car_crash_1d.png");

  // frog flying sprite
  GFX.carCrash2u = loadImage("car_crash_2u.png");
  GFX.carCrash2d = loadImage("car_crash_2d.png");

  // car sliding after split
  GFX.carCrash3u = loadImage("car_crash_3u.png");
  GFX.carCrash3d = loadImage("car_crash_3d.png");

  const fallback = GFX.carCrash[GFX.carCrash.length - 1];
  loadImage(
    "car_wreck_0.png",
    img => { GFX.carWreck = [img]; },
    _err => { GFX.carWreck = [fallback]; }
  );

  GFX.ambulance = loadImage("bimbulance.png");
  GFX.towTruck = loadImage("car_grar.png");
}

function setup() {
  createCanvas(windowWidth, windowHeight - UI_BAR_H);
  noSmooth();
  lastSpawnPos = createVector(mouseX, mouseY);

  preprocessJumpFrames();

  buildMenuBar();
  applyCanvasFitToWindow();
}

function draw() {
  background(235);

  // blood floor layer (pixel-art style)
  ensureBloodLayer();
  bloodLayer.clear();
  bloodLayer.push();
  bloodLayer.scale(1 / BLOOD_PIXEL_SCALE);
  for (const b of bloodSplats) {
    if (MODE === "animate") b.update();
    b.draw(bloodLayer);
  }
  bloodLayer.pop();
  postProcessBloodLayer();
  bloodSplats = bloodSplats.filter(b => !b.dead);

  push();
  noSmooth();
  imageMode(CORNER);
  image(bloodLayer, 0, 0, bloodLayer.width * BLOOD_PIXEL_SCALE, bloodLayer.height * BLOOD_PIXEL_SCALE);
  pop();

  if (brushLabel && brushSlider) brushLabel.html("Brush: " + brushSlider.value());
  updateEraserButtonUI();

  if (MODE === "animate") {
    // spawn scheduled once per frame
    trySpawnScheduledAmbulances();
    trySpawnScheduledTows();

    for (let c of cars) c.update();
    for (let f of frogs) f.update();

    handleCarFrogInteractions();
    handleChainCrashPropagation();

    // update crash pieces
    for (let p of crashPieces) p.update();
    crashPieces = crashPieces.filter(p => !p.dead);

    // update ambulances
    for (let a of ambulances) a.update();
    ambulances = ambulances.filter(a => !a.dead);

    // update tow trucks
    for (let t of towTrucks) t.update();
    towTrucks = towTrucks.filter(t => !t.dead);

    cars = cars.filter(c => !c.isFarOffscreen() && !c._towedAway);
    frogs = frogs.filter(f => !f.removed);
  }

  // draw stamps in creation order so new stamps sit on top
  const render = [];
  for (let f of frogs) render.push({ t: f.createdAt, obj: f });
  for (let c of cars) render.push({ t: c.createdAt, obj: c });
  render.sort((a, b) => a.t - b.t);
  for (const r of render) r.obj.draw();

  // draw crash pieces on top of stamps
  for (let p of crashPieces) p.draw();

  // tow trucks
  for (let t of towTrucks) t.draw();

  // ambulances on top
  for (let a of ambulances) a.draw();
}

// -------------------------
// UI (menu bar)
// -------------------------
function buildMenuBar() {
  uiBar = createDiv("");
  uiBar.id("uiBar");
  uiBar.style("position", "fixed");
  uiBar.style("left", "0px");
  uiBar.style("top", "0px");
  uiBar.style("width", "100%");
  uiBar.style("height", UI_BAR_H + "px");
  uiBar.style("display", "flex");
  uiBar.style("align-items", "center");
  uiBar.style("gap", "10px");
  uiBar.style("padding", "8px 10px");
  uiBar.style("box-sizing", "border-box");
  uiBar.style("background", "rgba(245,245,245,0.96)");
  uiBar.style("border-bottom", "1px solid rgba(0,0,0,0.12)");
  uiBar.style("z-index", "9999");
  uiBar.style("font-family", "monospace");
  uiBar.style("font-size", "12px");

  modeBtn = createButton("Mode: ANIMATE");
  modeBtn.parent(uiBar);
  modeBtn.mousePressed(toggleMode);

  eraserBtn = createButton("Eraser: OFF");
  eraserBtn.parent(uiBar);
  eraserBtn.mousePressed(() => { ERASER = !ERASER; });

  clearBtn = createButton("Clear Canvas");
  clearBtn.parent(uiBar);
  clearBtn.mousePressed(clearCanvasAll);

  uiSep();

  /* Canvas size presets removed (always fit to window).
  if (false) {
  sizeLabel = createDiv("Canvas:");
  sizeLabel.parent(uiBar);

  sizeSelect = createSelect();
  sizeSelect.parent(uiBar);
  sizeSelect.style("height", "24px");
  sizeSelect.option("Fit Window", "fit");
  sizeSelect.option("Screen 800×600", "800x600");
  sizeSelect.option("Screen 1080×1080", "1080x1080");
  sizeSelect.option("Screen 1920×1080 (HD)", "1920x1080");
  sizeSelect.option("Screen 1080×1920 (Story)", "1080x1920");
  sizeSelect.option("Print A4 Portrait (2480×3508)", "2480x3508");
  sizeSelect.option("Print A4 Landscape (3508×2480)", "3508x2480");
  sizeSelect.option("Print A3 Portrait (3508×4961)", "3508x4961");
  sizeSelect.option("Print A3 Landscape (4961×3508)", "4961x3508");
  sizeSelect.selected("fit");
  sizeSelect.changed(onCanvasPresetChanged);
  }
  */
  brushLabel = createDiv("Brush: 1");
  brushLabel.parent(uiBar);
  brushLabel.style("min-width", "70px");

  brushSlider = createSlider(1, 8, 1, 1);
  brushSlider.parent(uiBar);
  brushSlider.style("width", "140px");

  /* Fill mode removed.
  if (false) {
    uiSep();

  const fillText = createDiv("Fill mode:");
  fillText.parent(uiBar);

  fillInput = createInput("0");
  fillInput.parent(uiBar);
  fillInput.size(45, 22);

  fillBtn = createButton("Fill Frogs");
  fillBtn.parent(uiBar);
  fillBtn.mousePressed(fillScreenWithFrogs);
  }
  */

  const hint = createDiv("Drag: horizontal=cars, vertical=frogs");
  hint.parent(uiBar);
  hint.style("margin-left", "auto");
  hint.style("opacity", "0.55");
}

function uiSep() {
  const sep = createDiv(" | ");
  sep.parent(uiBar);
  sep.style("opacity", "0.45");
}

function updateEraserButtonUI() {
  if (!eraserBtn) return;
  eraserBtn.html(ERASER ? "Eraser: ON" : "Eraser: OFF");
  eraserBtn.style("background", ERASER ? "rgba(0,0,0,0.08)" : "");
}

function toggleMode() {
  MODE = MODE === "animate" ? "still" : "animate";
  modeBtn.html(MODE === "animate" ? "Mode: ANIMATE" : "Mode: STILL");

  if (MODE === "still") freezeAllPlacedSprites();
  else unfreezeAllPlacedSprites();
}

function freezeAllPlacedSprites() {
  for (let f of frogs) f.frozenImg = f.currentImage();
  for (let c of cars) c.frozenImg = c.getRenderImage();
  for (let b of bloodSplats) b.freezeNow && b.freezeNow();
  for (let a of ambulances) a.freeze();
  for (let t of towTrucks) t.freeze();

  crashQueue = [];
  chainCooldown = 0;
  fastFrames = 0;
  stoppedFrames = 0;

  // freeze crash pieces (simple: stop them)
  for (let p of crashPieces) { p.dead = true; }
  crashPieces = [];
}

function unfreezeAllPlacedSprites() {
  for (let f of frogs) f.frozenImg = null;
  for (let c of cars) c.frozenImg = null;
  for (let a of ambulances) a.unfreeze();
  for (let t of towTrucks) t.unfreeze();
}

function clearCanvasAll() {
  cars = [];
  frogs = [];
  bloodSplats = [];
  ambulances = [];
  crashPieces = [];
  crashQueue = [];
  towTrucks = [];
  creationCounter = 0;
}

function applyCanvasFitToWindow() {
  const c = document.querySelector("canvas");
  if (c) {
    c.style.position = "absolute";
    c.style.left = "0px";
    c.style.top = UI_BAR_H + "px";
  }

  resizeCanvas(windowWidth, max(1, windowHeight - UI_BAR_H));

  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";

  ensureBloodLayer();
}

function windowResized() {
  applyCanvasFitToWindow();
}

// -------------------------
// Mouse mapping (canvas under fixed bar)
// -------------------------
function canvasMouseX() { return mouseX; }
function canvasMouseY() { return mouseY - UI_BAR_H; }
function canvasPMouseX() { return pmouseX; }
function canvasPMouseY() { return pmouseY - UI_BAR_H; }

// -------------------------
// Eraser behavior
// -------------------------
function eraseAt(x, y) {
  const R = ERASER_RADIUS;

  for (let i = frogs.length - 1; i >= 0; i--) {
    const f = frogs[i];
    if (dist(x, y, f.pos.x, f.pos.y) < R) {
      frogs.splice(i, 1);
      return;
    }
  }

  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    if (dist(x, y, c.pos.x, c.pos.y) < R) {
      cars.splice(i, 1);
      return;
    }
  }

  for (let i = bloodSplats.length - 1; i >= 0; i--) {
    const b = bloodSplats[i];
    if (b && b.hitTest && b.hitTest(x, y)) {
      bloodSplats.splice(i, 1);
      return;
    }
  }

  for (let i = crashPieces.length - 1; i >= 0; i--) {
    const p = crashPieces[i];
    if (p && dist(x, y, p.pos.x, p.pos.y) < U(40)) {
      crashPieces.splice(i, 1);
      return;
    }
  }
}

// -------------------------
// Input / brush logic
// -------------------------
function mousePressed() {
  if (mouseY <= UI_BAR_H) return;

  lastSpawnPos = createVector(canvasMouseX(), canvasMouseY());

  if (ERASER) {
    eraseAt(lastSpawnPos.x, lastSpawnPos.y);
    return;
  }

  prevSegSpeed = 0;
  chainCooldown = 0;
  fastFrames = 0;
  stoppedFrames = 0;
}

function mouseDragged() {
  if (mouseY <= UI_BAR_H) return;

  const x = canvasMouseX();
  const y = canvasMouseY();
  const px = canvasPMouseX();
  const py = canvasPMouseY();

  if (x < 0 || x > width || y < 0 || y > height) return;
  if (px < 0 || px > width || py < 0 || py > height) return;

  if (ERASER) {
    eraseAt(x, y);
    lastSpawnPos.set(x, y);
    return;
  }

  const vx = x - px;
  const vy = y - py;
  const sp = Math.sqrt(vx * vx + vy * vy);

  if (MODE === "animate") {
    if (chainCooldown > 0) chainCooldown--;

    const FAST_ENOUGH = 22;
    const STOPPED = 2.2;
    const BRAKE_DROP = 5;
    const NEED_FAST_FRAMES = 2;
    const NEED_STOP_FRAMES = 1;

    if (sp >= FAST_ENOUGH) fastFrames++;
    else fastFrames = max(0, fastFrames - 1);

    if (sp <= STOPPED) stoppedFrames++;
    else stoppedFrames = 0;

    const hardBrake = prevSegSpeed - sp >= BRAKE_DROP;

    if (chainCooldown === 0 && fastFrames >= NEED_FAST_FRAMES && hardBrake && stoppedFrames >= NEED_STOP_FRAMES) {
      triggerChainCrash(x, y);
      chainCooldown = 28;
      fastFrames = 0;
      stoppedFrames = 0;
    }

    prevSegSpeed = sp;
  }

  const horizontal = Math.abs(vx) > Math.abs(vy);
  const d = dist(x, y, lastSpawnPos.x, lastSpawnPos.y);
  const minDist = horizontal ? CAR_SPAWN_MIN_DIST : FROG_SPAWN_MIN_DIST;
  if (d < minDist) return;

  if (horizontal) spawnCar(vx, sp, x, y);
  else {
    const n = brushSlider ? brushSlider.value() : 1;
    if (n === 1) spawnFrog(x, y);
    else spawnFrogBurst(x, y, n);
  }

  lastSpawnPos.set(x, y);
}

// -------------------------
// Spawning helpers
// -------------------------
function nextCreatedAt() {
  creationCounter += 1;
  return creationCounter;
}

function spawnCar(vx, sp, x, y) {
  const dir = vx >= 0 ? 1 : -1;
  y = clampWorldY(y);

  let t = constrain(sp / 120, 0, 1);
  t = pow(t, 1.8);
  const carSpeed = lerp(UF(2.0), UF(12.0), t);

  const createdAt = nextCreatedAt();

  if (MODE === "still") {
    const c = new Car(x, y, dir, 0, createdAt);
    cars.push(c);
    c.frozenImg = c.getRenderImage();
    stillCollideCarWithFrogs(c);
    return;
  }

  cars.push(new Car(x, y, dir, carSpeed, createdAt));
}

function spawnFrog(x, y, opts = {}) {
  const allowStack = (opts.allowStack !== false);
  y = clampWorldY(y);
  const createdAt = nextCreatedAt();

  if (MODE === "still") {
    const nf = new Frog(x, y, createdAt);
    frogs.push(nf);
    stillCollideFrogWithCars(nf);
    nf.frozenImg = nf.currentImage();
    return;
  }

  if (allowStack) {
    const R_NEAR = FROG_STACK_NEAR_RADIUS;
    const STACK_COOLDOWN = 18;

    let nearest = null;
    let bestD = Infinity;

    for (let f of frogs) {
      if (f.isSquished()) continue;
      const d = dist(x, y, f.pos.x, f.pos.y);
      if (d < R_NEAR && d < bestD) {
        bestD = d;
        nearest = f;
      }
    }

    if (nearest) {
      if (nearest.pileCooldown === 0) {
        nearest.pile = min(nearest.pile + 1, 5);
        nearest.bump();
        nearest.pileCooldown = STACK_COOLDOWN;
      }
      return;
    }
  }

  frogs.push(new Frog(x, y, createdAt));
}

function spawnFrogBurst(x, y, count) {
  const spread = FROG_RENDER_SIZE * 0.32 + count * 5;
  // Burst should always place multiple frogs, not convert into a pile.
  for (let i = 0; i < count; i++) spawnFrog(x + random(-spread, spread), y + random(-spread, spread), { allowStack: false });
}

// -------------------------
// STILL mode collisions (stamp-time only)
// -------------------------
function stillCollideCarWithFrogs(car) {
  for (let f of frogs) {
    if (f.isSquished()) continue;
    if (rectCircleOverlap(car.getAABB(), f.pos, f.hitRadius)) {
      f.squish(car.dir);
      f.frozenImg = f.currentImage();
    }
  }
}

function stillCollideFrogWithCars(frog) {
  for (let c of cars) {
    if (rectCircleOverlap(c.getAABB(), frog.pos, frog.hitRadius)) {
      frog.squish(c.dir);
      frog.frozenImg = frog.currentImage();
      return;
    }
  }
}

// -------------------------
// Rules: speed needed vs pile (ANIMATE mode)
// -------------------------
function requiredSpeedToSquish(pile) {
  // Higher = frogs survive more often (evade instead of getting squished).
  const BASE = UF(9.4);
  const STEP = UF(1.05);
  return BASE + (pile - 1) * STEP;
}

// -------------------------
// Interactions (ANIMATE mode only)
// -------------------------
function handleCarFrogInteractions() {
  for (let c of cars) {
    if (c.state === "wreck") continue;

    for (let f of frogs) {
      if (f.isSquished()) continue;

      // Proactive evasion: dodge slightly BEFORE contact (pile=1 only)
      if (f.pile === 1 && c.state === "drive" && f.evadeCooldown === 0) {
        const dy = abs(f.pos.y - c.pos.y);
        if (dy < FROG_EVADE_WARN_Y) {
          const ahead = (f.pos.x - c.pos.x) * c.dir; // >0 means car is behind, approaching
          const warnX = FROG_EVADE_BASE_WARN_X + c.speed * FROG_EVADE_LEAD_FRAMES;
          if (ahead > 0 && ahead < warnX) {
            f.evadeFrom(c);
            continue;
          }
        }
      }

      if (rectCircleOverlap(c.getAABB(), f.pos, f.hitRadius)) {
        const pile = f.pile;
        const need = requiredSpeedToSquish(pile);

        if (pile === 1) {
          if (c.speed >= need) {
            f.squish(c.dir);
            c.onHit(true);
          } else {
            f.evadeFrom(c);
          }
        } else {
          if (c.speed >= need) {
            f.squish(c.dir);
            c.onHit(true);
          } else {
            c.crash();
            f.bump();
          }
        }
      }
    }
  }
}

function rectCircleOverlap(aabb, cpos, r) {
  const cx = constrain(cpos.x, aabb.x, aabb.x + aabb.w);
  const cy = constrain(cpos.y, aabb.y, aabb.y + aabb.h);
  const dx = cpos.x - cx;
  const dy = cpos.y - cy;
  return (dx * dx + dy * dy) <= r * r;
}

// -------------------------
// Chain crash (ANIMATE mode only)
// -------------------------
let crashQueue = [];

function triggerChainCrash(x, y) {
  const rad = U(90);
  crashQueue.push({ pos: createVector(x, y), radius: rad, ttl: 5, delay: 0 });
  crashCarsInRadius(x, y, rad);
}

function handleChainCrashPropagation() {
  for (let i = crashQueue.length - 1; i >= 0; i--) {
    const q = crashQueue[i];
    q.delay -= 1;
    if (q.delay > 0) continue;

    if (q.ttl > 0) {
      const newly = crashCarsInRadius(q.pos.x, q.pos.y, q.radius);
      for (let c of newly) {
        crashQueue.push({
          pos: c.pos.copy(),
          radius: q.radius * 0.72,
          ttl: q.ttl - 1,
          delay: 6
        });
      }
    }
    crashQueue.splice(i, 1);
  }
}

function crashCarsInRadius(x, y, rad) {
  const newly = [];
  for (let c of cars) {
    if (c.state === "crash" || c.state === "wreck") continue;
    if (dist(x, y, c.pos.x, c.pos.y) < rad) {
      c.crash();
      newly.push(c);
    }
  }
  return newly;
}

// -------------------------
// BLOOD SYSTEM (fade after 5s)
// -------------------------
function bloodAlphaFromBorn(bornMs) {
  const age = millis() - bornMs;
  if (age <= BLOOD_FADE_START_MS) return 255;
  const t = (age - BLOOD_FADE_START_MS) / BLOOD_FADE_DUR_MS;
  return round(lerp(255, 0, constrain(t, 0, 1)));
}

function bloodIsDeadFromBorn(bornMs) {
  const age = millis() - bornMs;
  return age > (BLOOD_FADE_START_MS + BLOOD_FADE_DUR_MS);
}

class BloodSpray {
  constructor(x, y, dir, power = 1.0, freezeAfterFrames = 28) {
    this.x = x;
    this.y = y;
    this.dir = dir;
    this.power = power;

    this.drops = [];
    this.puddles = [];

    this.freezeAfter = freezeAfterFrames;
    this.frozen = (this.freezeAfter <= 0);

    this.bornMs = millis();
    this.alpha = 255;
    this.dead = false;

    const N = floor(18 + 18 * power);
    for (let i = 0; i < N; i++) {
      const vx = dir * random(UF(6), UF(14)) * (0.8 + power * 0.6);
      const vy = -random(UF(8), UF(18)) * (0.8 + power * 0.6);
      const r = random(UF(2.5), UF(5.5));
      this.drops.push(new BloodDrop(x, y, vx, vy, r));
    }
  }

  freezeNow() {
    this.frozen = true;
    this.freezeAfter = 0;
    this.drops = [];
    for (const p of this.puddles) p.freezeNow();
  }

  hitTest(mx, my) {
    return dist(mx, my, this.x, this.y) < BLOOD_SPRAY_HIT_RADIUS;
  }

  update() {
    this.alpha = bloodAlphaFromBorn(this.bornMs);
    if (bloodIsDeadFromBorn(this.bornMs)) {
      this.dead = true;
      return;
    }

    if (this.frozen) return;

    this.freezeAfter--;
    if (this.freezeAfter <= 0) {
      this.drops = [];
      for (const p of this.puddles) p.freezeNow();
      this.frozen = true;
      return;
    }

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.update();

      if (!d.settled && d.vy > 0 && d.y >= (d.groundY - random(UF(2), UF(10)))) {
        d.settled = true;
        this.puddles.push(new BloodPuddle(d.x, d.groundY, this.dir, d.r, d.vx));
        this.drops.splice(i, 1);
      }
    }

    for (const p of this.puddles) p.update();
  }

  draw(pg) {
    const a = this.alpha;
    for (const p of this.puddles) p.draw(pg, a);
    for (const d of this.drops) d.draw(pg, a);
  }
}

class BloodDrop {
  constructor(x, y, vx, vy, r) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.r = r;

    this.g = UF(0.75);
    this.drag = 0.985;
    this.settled = false;

    this.spin = random(-0.25, 0.25);
    this.t = random(1000);

    this.groundY = y + random(UF(14), UF(26));
  }

  update() {
    const wob = (noise(this.t) - 0.5) * UF(0.7);
    this.t += 0.06;

    this.vy += this.g;
    this.vx *= this.drag;
    this.vy *= this.drag;

    this.x += this.vx + wob;
    this.y += this.vy;

    this.x = round(this.x);
    this.y = round(this.y);
  }

  draw(pg, alpha = 255) {
    pg.push();
    pg.noSmooth();
    pg.noStroke();
    pg.fill(140, 20, 30, alpha);

    const sp = sqrt(this.vx * this.vx + this.vy * this.vy);
    const stretch = constrain(map(sp, 0, UF(20), 1.0, 1.8), 1.0, 1.8);

    pg.translate(this.x, this.y);
    pg.rotate(atan2(this.vy, this.vx) + this.spin);
    pg.ellipse(0, 0, round(this.r * stretch), round(this.r));
    pg.pop();
  }
}

class BloodPuddle {
  constructor(x, y, dir, r, hitVx) {
    this.x = x;
    this.y = y;

    const smear = constrain(abs(hitVx) * 1.2, U(6), U(40));
    this.w = r * 6 + smear;
    this.h = r * 2.8;

    this.dir = dir;
    this.seed = random(100000);

    this.grow = 0;
    this.maxGrow = 1;
    this.frozen = false;
  }

  freezeNow() {
    this.frozen = true;
    this.grow = 1;
  }

  update() {
    if (this.frozen) return;
    this.grow = min(this.maxGrow, this.grow + 0.06);
    if (this.grow >= 1) this.frozen = true;
  }

  draw(pg, alpha = 255) {
    pg.push();
    pg.noSmooth();
    pg.translate(this.x, this.y);
    if (this.dir === -1) pg.scale(-1, 1);

    const e = this.grow * this.grow * (3 - 2 * this.grow);
    const w = this.w * e;
    const h = this.h * e;

    pg.noStroke();
    pg.fill(140, 20, 30, alpha);

    pg.beginShape();
    const n = 24;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * TWO_PI;
      const k = noise(this.seed + cos(t) * 0.9, this.seed * 0.77 + sin(t) * 0.9) - 0.5;

      const forward = max(0, cos(t));
      const rx = (w * 0.45) * (1 + forward * 0.8) * (1 + k * 0.35);
      const ry = (h * 0.55) * (1 + k * 0.35);

      const xx = cos(t) * rx + w * 0.10;
      const yy = sin(t) * ry;

      pg.curveVertex(round(xx), round(yy));
    }
    pg.endShape(CLOSE);

    pg.noStroke();
    pg.fill(235, 200, 205, alpha);
    pg.ellipse(round(-w * 0.08), round(-h * 0.18), max(U(2), w * 0.08), max(U(2), h * 0.18));

    pg.pop();
  }
}

class SimpleFloorSplat {
  constructor(x, y, dir, size = FROG_RENDER_SIZE) {
    this.x = x;
    this.y = y;
    this.dir = dir;
    this.size = size;

    this.grow = 0;
    this.growSpeed = 1 / 12;

    this.bornMs = millis();
    this.alpha = 255;
    this.dead = false;

    this.seed = random(100000);
    this.branches = [];
    const B = 7;
    for (let i = 0; i < B; i++) {
      this.branches.push({
        t: random(0.15, 1.0),
        offY: random(-0.22, 0.22),
        w: random(0.06, 0.12)
      });
    }
  }

  update() {
    this.alpha = bloodAlphaFromBorn(this.bornMs);
    if (bloodIsDeadFromBorn(this.bornMs)) {
      this.dead = true;
      return;
    }
    if (this.grow < 1) this.grow = min(1, this.grow + this.growSpeed);
  }

  hitTest(mx, my) {
    return dist(mx, my, this.x, this.y) < this.size * 1.2;
  }

  freezeNow() { this.grow = 1; }

  draw(pg) {
    const alpha = this.alpha;

    pg.push();
    pg.noSmooth();
    pg.translate(this.x, this.y);
    if (this.dir === -1) pg.scale(-1, 1);

    const e = this.grow * this.grow * (3 - 2 * this.grow);

    const L = this.size * 2.2 * e;
    const H = this.size * 0.32 * e;

    pg.noStroke();
    pg.fill(140, 20, 30, alpha);

    pg.beginShape();
    pg.curveVertex(round(-L * 0.25), round(-H * 0.25));
    pg.curveVertex(round(-L * 0.25), round(-H * 0.25));

    pg.curveVertex(round(L * 0.10),  round(-H * 0.55));
    pg.curveVertex(round(L * 0.55),  round(-H * 0.35));
    pg.curveVertex(round(L * 1.00),  round(0));

    pg.curveVertex(round(L * 0.55),  round(H * 0.35));
    pg.curveVertex(round(L * 0.10),  round(H * 0.55));

    pg.curveVertex(round(-L * 0.25), round(H * 0.25));
    pg.curveVertex(round(-L * 0.25), round(H * 0.25));
    pg.endShape(CLOSE);

    pg.noStroke();
    pg.fill(95, 10, 18, alpha);
    pg.beginShape();
    pg.curveVertex(round(-L * 0.12), round(-H * 0.12));
    pg.curveVertex(round(-L * 0.12), round(-H * 0.12));
    pg.curveVertex(round(L * 0.12),  round(-H * 0.30));
    pg.curveVertex(round(L * 0.55),  round(-H * 0.18));
    pg.curveVertex(round(L * 0.82),  round(0));
    pg.curveVertex(round(L * 0.55),  round(H * 0.18));
    pg.curveVertex(round(L * 0.12),  round(H * 0.30));
    pg.curveVertex(round(-L * 0.12), round(H * 0.12));
    pg.curveVertex(round(-L * 0.12), round(H * 0.12));
    pg.endShape(CLOSE);

    pg.noStroke();
    pg.fill(140, 20, 30, alpha);
    for (const b of this.branches) {
      const bx = L * (0.35 + b.t * 0.75);
      const by = H * b.offY;
      const bw = this.size * (b.w * 10) * e;
      pg.ellipse(round(bx), round(by), round(bw), round(bw * 0.55));
    }

    pg.pop();
  }
}

// -------------------------
// CRASH PIECE (FIXED): fall to LOCAL ground then slide-stop
// -------------------------
class CrashFrogPiece {
  constructor(x, y, dir, img, variant /* "u" | "d" */) {
    this.pos = createVector(x, y);
    this.vel = createVector(0, 0);

    this.dir = dir;
    this.variant = variant || "d";
    this.img = img;

    this.size = CRASH_PIECE_SIZE;

    // local ground, slightly below crash origin (not canvas bottom)
    this.groundY = y + U(22);

    // states: air -> slide -> rest
    this.state = "air";

    // initial throw: forward + up, then gravity
    const upKick = (this.variant === "u") ? 1.15 : 1.0;
    this.vel.x = dir * random(UF(6.5), UF(9.5));
    this.vel.y = -random(UF(9), UF(12)) * upKick;

    this.g = UF(0.85);
    this.airDrag = 0.985;
    this.slideFriction = 0.86;
    this.minStopSpeed = UF(0.35);

    this.rot = random(-0.25, 0.25);
    this.rotV = random(-0.03, 0.03);

    this.life = 260;
    this.dead = false;

    // for ambulance scheduling
    this.ambulanceScheduled = false;
    this.ambulanceSpawned = false;
    this.ambulanceSpawnAtMs = 0;
  }

  update() {
    if (this.dead) return;

    this.rot += this.rotV;

    if (this.state === "air") {
      this.vel.y += this.g;
      this.vel.mult(this.airDrag);
      this.pos.add(this.vel);

      if (this.pos.y >= this.groundY) {
        this.pos.y = this.groundY;
        this.vel.y = 0;
        this.vel.x *= 0.92;
        this.state = "slide";
        this.rotV *= 0.5;
      }
    } else if (this.state === "slide") {
      this.pos.y = this.groundY;
      this.pos.x += this.vel.x;
      this.vel.x *= this.slideFriction;

      this.pos.x = round(this.pos.x);
      this.pos.y = round(this.pos.y);

      if (abs(this.vel.x) < this.minStopSpeed) {
        this.vel.x = 0;
        this.state = "rest";

        // schedule ambulance only when resting
        if (MODE === "animate") scheduleAmbulanceForCrashPiece(this);
      }
    } else {
      // rest
    }

    this.life--;
    if (this.life <= 0) this.dead = true;
  }

  draw() {
    if (!this.img) return;
    push();
    imageMode(CENTER);
    translate(this.pos.x, this.pos.y);
    if (this.state !== "rest") rotate(this.rot);
    image(this.img, 0, 0, this.size, this.size);
    pop();
  }
}

// -------------------------
// AMBULANCES (0.5s delayed per crushed frog / crash piece)
// -------------------------
function scheduleAmbulanceForFrog(frog) {
  if (frog.ambulanceScheduled) return;
  frog.ambulanceScheduled = true;
  frog.ambulanceSpawnAtMs = millis() + AMBULANCE_SPAWN_DELAY_MS;
}

function scheduleAmbulanceForCrashPiece(piece) {
  if (piece.ambulanceScheduled) return;
  piece.ambulanceScheduled = true;
  piece.ambulanceSpawnAtMs = millis() + AMBULANCE_SPAWN_DELAY_MS;
}

// --------- target helpers (FIX for isSquished error) ---------
function targetIsValidForAmbulance(t) {
  if (!t) return false;

  // Frog target: must be squished and not removed
  if (typeof t.isSquished === "function") {
    return t.isSquished() && !t.removed;
  }

  // Crash piece target: must be resting and not dead
  if ("state" in t && typeof t.dead === "boolean") {
    return (t.state === "rest") && !t.dead;
  }

  return false;
}

function targetMarkRemoved(t) {
  if (!t) return;

  // Frog
  if ("removed" in t) t.removed = true;

  // Crash piece
  if ("dead" in t) t.dead = true;
}

function trySpawnScheduledAmbulances() {
  // frogs
  for (const f of frogs) {
    if (!f.isSquished() || f.removed) continue;
    if (!f.ambulanceScheduled) continue;
    if (f.ambulanceSpawned) continue;
    if (millis() < f.ambulanceSpawnAtMs) continue;

    spawnAmbulanceForTarget(f);
    f.ambulanceSpawned = true;
  }

  // crash pieces
  for (const p of crashPieces) {
    if (p.dead) continue;
    if (p.state !== "rest") continue;
    if (!p.ambulanceScheduled) continue;
    if (p.ambulanceSpawned) continue;
    if (millis() < p.ambulanceSpawnAtMs) continue;

    spawnAmbulanceForTarget(p);
    p.ambulanceSpawned = true;
  }
}

function spawnAmbulanceForTarget(target) {
  const fromLeft = (target.pos.x > width * 0.5);
  const x = fromLeft ? -AMBULANCE_SPAWN_EDGE_PAD : width + AMBULANCE_SPAWN_EDGE_PAD;
  let y = target.pos.y + random(-U(40), U(40));

  const tries = 14;
  for (let t = 0; t < tries; t++) {
    let ok = true;
    for (const a of ambulances) {
      if (abs(a.pos.y - y) < U(34) && abs(a.pos.x - x) < U(140)) { ok = false; break; }
    }
    if (ok) break;
    y += random([-U(58), -U(42), U(42), U(58)]);
    y = constrain(y, U(60), height - U(60));
  }

  const dir = fromLeft ? 1 : -1;
  ambulances.push(new Ambulance(x, y, dir, nextCreatedAt(), target));
}

function ambulanceSeparationForce(self) {
  let fx = 0, fy = 0;

  for (const other of ambulances) {
    if (other === self) continue;

    const dx = self.pos.x - other.pos.x;
    const dy = self.pos.y - other.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 0.0001) continue;

    const d = sqrt(d2);
    if (d < AMBULANCE_SEP_RADIUS) {
      const s = (AMBULANCE_SEP_RADIUS - d) / AMBULANCE_SEP_RADIUS;
      fx += (dx / d) * s;
      fy += (dy / d) * s;
    }
  }

  const mag = sqrt(fx * fx + fy * fy);
  if (mag > AMBULANCE_MAX_SEP) {
    fx = (fx / mag) * AMBULANCE_MAX_SEP;
    fy = (fy / mag) * AMBULANCE_MAX_SEP;
  }

  return createVector(fx, fy);
}

// -------------------------
// TOW scheduling
// -------------------------
function scheduleTowForCar(car) {
  if (car.towScheduled) return;
  car.towScheduled = true;
  car.towSpawnAtMs = millis() + TOW_SPAWN_DELAY_MS;
}

function trySpawnScheduledTows() {
  for (const c of cars) {
    if (c.state !== "wreck") continue;
    if (c.towSpawned) continue;
    if (!c.towScheduled) continue;
    if (millis() < c.towSpawnAtMs) continue;

    spawnTowForCar(c);
    c.towSpawned = true;
  }
}

function spawnTowForCar(car) {
  const fromLeft = (car.pos.x > width * 0.5);
  const x = fromLeft ? -TOW_SPAWN_EDGE_PAD : width + TOW_SPAWN_EDGE_PAD;
  let y = car.pos.y + random(-U(30), U(30));
  y = constrain(y, U(60), height - U(60));

  const dir = fromLeft ? 1 : -1;
  towTrucks.push(new TowTruck(x, y, dir, nextCreatedAt(), car));
}

// -------------------------
// TowTruck class
// -------------------------
class TowTruck {
  constructor(x, y, dir, createdAt, targetCar) {
    this.createdAt = createdAt;
    this.pos = createVector(x, y);
    this.vel = createVector(dir * random(UF(5.5), UF(7.5)), 0);
    this.dir = dir;

    this.size = TOW_TRUCK_RENDER_SIZE;
    this.baseSpeed = random(UF(5.8), UF(7.8));
    this.maxSpeed = this.baseSpeed * 1.25;

    this.state = "toTarget"; // "toTarget" | "hook" | "leave"
    this.target = targetCar;

    this.hookTimer = 0;
    this.dead = false;
    this.frozen = false;
  }

  freeze() { this.frozen = true; }
  unfreeze() { this.frozen = false; }

  update() {
    if (this.frozen) return;

    if (this.state === "toTarget") {
      if (!this.target || this.target.isFarOffscreen()) {
        this.state = "leave";
      } else {
        const tx = this.target.pos.x;
        const ty = this.target.pos.y;

        const toT = createVector(tx - this.pos.x, ty - this.pos.y);

        if (abs(toT.x) > 1) this.dir = (toT.x >= 0) ? 1 : -1;

        toT.normalize();
        let desired = toT.mult(this.maxSpeed);
        desired.y = constrain(desired.y, -UF(2.2), UF(2.2));

        const steer = desired.copy().sub(this.vel).mult(0.16);
        this.vel.add(steer);

        const sp = this.vel.mag();
        if (sp > this.maxSpeed) this.vel.mult(this.maxSpeed / sp);
        if (sp < this.baseSpeed * 0.75) this.vel.mult((this.baseSpeed * 0.75) / max(0.0001, sp));

        this.pos.add(this.vel);
        this.pos.y = constrain(this.pos.y, U(50), height - U(50));

        if (abs(tx - this.pos.x) < TOW_PICKUP_DIST && abs(ty - this.pos.y) < TOW_PICKUP_DIST) {
          this.state = "hook";
          this.hookTimer = 18;
          this.vel.mult(0.2);
        }
      }
    }
    else if (this.state === "hook") {
      this.hookTimer--;
      if (this.hookTimer <= 0) {
        this.state = "leave";
        this.dir = (this.pos.x < width * 0.5) ? -1 : 1;
        this.vel = createVector(this.dir * this.baseSpeed, 0);
      }
    }
    else if (this.state === "leave") {
      // tow the car out
      if (this.target && this.target.state === "wreck") {
        this.target.pos.x = this.pos.x - this.dir * U(38);
        this.target.pos.y = this.pos.y + U(2);
      }

      this.vel.x = this.dir * this.maxSpeed;
      this.vel.y *= 0.92;

      this.pos.add(this.vel);
      this.pos.y = constrain(this.pos.y, U(50), height - U(50));

      if (this.pos.x < -width - U(420) || this.pos.x > width + U(420)) {
        if (this.target) this.target._towedAway = true;
        this.dead = true;
      }
    }
  }

  draw() {
    if (!GFX.towTruck) return;
    push();
    translate(this.pos.x, this.pos.y);
    imageMode(CENTER);
    noSmooth();

    // PNG faces LEFT by default; moving RIGHT => mirror
    if (this.dir === 1) scale(-1, 1);

    image(GFX.towTruck, 0, 0, this.size, this.size);
    pop();
  }
}

// -------------------------
// Ambulance class (FIXED for frog + crashPiece targets)
// -------------------------
class Ambulance {
  constructor(x, y, dir, createdAt, targetAny) {
    this.createdAt = createdAt;
    this.pos = createVector(x, y);
    this.vel = createVector(dir * random(UF(6.2), UF(8.2)), 0);

    this.dir = dir;
    this.size = AMBULANCE_RENDER_SIZE;

    this.baseSpeed = random(UF(6.4), UF(8.6));
    this.maxSpeed = this.baseSpeed * 1.28;

    this.state = "toTarget"; // "toTarget" | "pickup" | "leave"
    this.target = targetAny || null;

    this.pickupTimer = 0;
    this.dead = false;
    this.frozen = false;

    // stuck detector
    this.prevTargetDist = null;
    this.noProgressFrames = 0;

    // lane
    this.laneY = y;
  }

  freeze() { this.frozen = true; }
  unfreeze() { this.frozen = false; }

  update() {
    if (this.frozen) return;

    if (this.state === "toTarget") {
      if (!targetIsValidForAmbulance(this.target)) {
        this.state = "leave";
        this.prevTargetDist = null;
        this.noProgressFrames = 0;
      } else {
        const tx = this.target.pos.x;
        const ty = this.target.pos.y;

        const toT = createVector(tx - this.pos.x, ty - this.pos.y);
        const distT = toT.mag();

        if (abs(toT.x) > 1) this.dir = (toT.x >= 0) ? 1 : -1;

        toT.normalize();
        let desired = toT.mult(this.maxSpeed);
        desired.y = constrain(desired.y, -UF(2.6), UF(2.6));

        let sep = ambulanceSeparationForce(this).mult(AMBULANCE_SEP_FORCE);
        const nearRad = U(70);
        const near = distT < nearRad ? map(distT, 0, nearRad, 0.15, 1.0) : 1.0;
        sep.mult(near);

        const lanePull = constrain((this.laneY - this.pos.y) * 0.01, -0.35, 0.35);

        const steer = desired.copy().sub(this.vel).mult(0.18);
        steer.add(sep);
        steer.y += lanePull;

        this.vel.add(steer);

        const sp = this.vel.mag();
        if (sp > this.maxSpeed) this.vel.mult(this.maxSpeed / sp);
        if (sp < this.baseSpeed * 0.70) this.vel.mult((this.baseSpeed * 0.70) / max(0.0001, sp));

        if (this.prevTargetDist === null) this.prevTargetDist = distT;
        const progress = this.prevTargetDist - distT;

        if (progress < AMBULANCE_PROGRESS_EPS) this.noProgressFrames++;
        else this.noProgressFrames = max(0, this.noProgressFrames - 2);

        this.prevTargetDist = distT;

         if (this.noProgressFrames > AMBULANCE_STUCK_FRAMES) {
           this.noProgressFrames = 0;
           this.laneY = constrain(this.pos.y + random([-U(80), -U(60), U(60), U(80)]), U(60), height - U(60));
           this.vel.y += random([-UF(2.2), UF(2.2)]);
           this.vel.x += this.dir * random(UF(0.8), UF(1.6));
         }

         this.pos.add(this.vel);
         this.pos.y = constrain(this.pos.y, U(50), height - U(50));

        if (abs(tx - this.pos.x) < AMBULANCE_PICKUP_DIST && abs(ty - this.pos.y) < AMBULANCE_PICKUP_DIST) {
          this.state = "pickup";
          this.pickupTimer = 22;
          this.vel.mult(0.2);
        }
      }
    }
    else if (this.state === "pickup") {
      this.pickupTimer--;
      if (this.pickupTimer <= 0) {
        targetMarkRemoved(this.target);
        this.target = null;
        this.state = "leave";

        this.dir = (this.pos.x < width * 0.5) ? -1 : 1;
        this.vel = createVector(this.dir * this.baseSpeed, 0);
        this.laneY = this.pos.y;
      }
    }
    else if (this.state === "leave") {
      const sep = ambulanceSeparationForce(this).mult(AMBULANCE_SEP_FORCE * 0.6);
      const desiredLeave = createVector(this.dir * this.maxSpeed, 0);
      const steer = desiredLeave.sub(this.vel).mult(0.15).add(sep);

      this.vel.add(steer);
      const sp = this.vel.mag();
      if (sp > this.maxSpeed) this.vel.mult(this.maxSpeed / sp);

      this.pos.add(this.vel);
      this.pos.y = constrain(this.pos.y, U(50), height - U(50));

      if (this.pos.x < -width - U(320) || this.pos.x > width + U(320)) this.dead = true;
    }
  }

  draw() {
    if (!GFX.ambulance) return;

    push();
    translate(this.pos.x, this.pos.y);
    imageMode(CENTER);
    noSmooth();

    // PNG faces LEFT by default; moving RIGHT => mirror
    if (this.dir === 1) scale(-1, 1);

    image(GFX.ambulance, 0, 0, this.size, this.size);
    pop();
  }
}

// -------------------------
// Frog / Car classes
// -------------------------
class Frog {
  constructor(x, y, createdAt) {
    this.createdAt = createdAt;
    this.pos = createVector(x, clampWorldY(y));

    this.pile = 1;
    this.pileCooldown = 0;
    this.pileFrameIndex = null;

    this.size = FROG_RENDER_SIZE;
    this.hitRadius = FROG_HIT_RADIUS;

    this.state = "idle";
    this.anims = {
      idle: new Animation(GFX.frogIdle, 1, true),
      jump: new Animation(GFX.frogJump, 18, false),
      squished: new Animation(GFX.frogSquish, 1, false)
    };
    this.anim = this.anims.idle;

    this.startPos = this.pos.copy();
    this.targetPos = this.pos.copy();
    this.jumpLift = 0;
    this.bounce = 0;

    this.jumpDirY = -1;

    this.frozenImg = null;

    this.removed = false;

    this.evadeCooldown = 0;

    // per-frog ambulance scheduling
    this.ambulanceScheduled = false;
    this.ambulanceSpawned = false;
    this.ambulanceSpawnAtMs = 0;
  }

  isSquished() { return this.state === "squished"; }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.anim = this.anims[s];
    this.anim.reset();
  }

  bump() { this.bounce = 1.0; }

  evadeFrom(car) {
    if (this.isSquished()) return;
    if (this.state === "jump") return;
    if (this.evadeCooldown > 0) return;

    this.setState("jump");
    this.bump();
    this.evadeCooldown = FROG_EVADE_COOLDOWN_FRAMES;

    const awayY = this.pos.y < car.pos.y ? -1 : 1;
    this.jumpDirY = awayY;

    this.startPos = this.pos.copy();
    const side = U(92);
    const forward = U(14);
    this.targetPos = createVector(this.pos.x + car.dir * forward, clampWorldY(this.pos.y + awayY * side));
  }

  squish(dir) {
    const groundY = this.pos.y + this.size * 0.28;

    const sprayFreeze = (MODE === "still") ? 0 : 26;
    const spray = new BloodSpray(this.pos.x, this.pos.y + U(8), dir, 1.0, sprayFreeze);
    for (const d of spray.drops) d.groundY = groundY + random(-U(2), U(6));
    bloodSplats.push(spray);

    bloodSplats.push(new SimpleFloorSplat(this.pos.x, groundY, dir, this.size));

    this.setState("squished");
    this.pile = 1;
    this.jumpLift = 0;
    this.pos.x += dir * U(6);

    // schedule ambulance half a second after crash (animate mode only)
    if (MODE === "animate") scheduleAmbulanceForFrog(this);
  }

  update() {
    this.pileCooldown = max(0, this.pileCooldown - 1);
    this.evadeCooldown = max(0, this.evadeCooldown - 1);

    this.anim.update();
    this.bounce *= 0.88;

    if (this.state === "jump") {
      const p = this.anim.progress01();
      const e = p * p * (3 - 2 * p);

      this.pos.x = lerp(this.startPos.x, this.targetPos.x, e);
      this.pos.y = lerp(this.startPos.y, this.targetPos.y, e);

      this.jumpLift = -sin(p * PI) * U(22);

      if (this.anim.done) {
        this.jumpLift = 0;
        this.setState("idle");
      }
    }

    this.pos.y = clampWorldY(this.pos.y);
  }

  jumpFrameForced() {
    if (!GFX.frogJump || GFX.frogJump.length < 6) return this.anim.frame();

    const p = this.anim.progress01();
    const group = (this.jumpDirY === 1) ? [3, 4, 5] : [0, 1, 2];

    let idx;
    if (p < 0.33) idx = 0;
    else if (p < 0.66) idx = 1;
    else idx = 2;
    if (p > 0.80) idx = 1;

    return GFX.frogJump[group[constrain(idx, 0, 2)]];
  }

  currentImage() {
    if (this.pileFrameIndex !== null && GFX.frogPile && GFX.frogPile.length > 0) {
      return GFX.frogPile[constrain(this.pileFrameIndex, 0, GFX.frogPile.length - 1)];
    }

    if (this.state === "jump") return this.jumpFrameForced();
    if (this.state === "squished") return this.anim.frame();

    if (this.pile > 1 && GFX.frogPile && GFX.frogPile.length >= 1) {
      const idx = this.pile - 2;
      return GFX.frogPile[constrain(idx, 0, GFX.frogPile.length - 1)];
    }

    return this.anim.frame();
  }

  draw() {
    const img = (MODE === "still" && this.frozenImg) ? this.frozenImg : this.currentImage();
    if (!img) return;

    push();
    translate(this.pos.x, this.pos.y + this.jumpLift + -this.bounce * U(6));
    imageMode(CENTER);
    image(img, 0, 0, this.size, this.size);
    pop();
  }
}

class Car {
  constructor(x, y, dir, speed, createdAt) {
    this.createdAt = createdAt;
    this.pos = createVector(x, clampWorldY(y));
    this.dir = dir;
    this.speed = speed;

    this.renderW = CAR_RENDER_SIZE;
    this.renderH = CAR_RENDER_SIZE;

    this.w = CAR_BODY_W;
    this.h = CAR_BODY_H;

    this.state = "drive";
    this.anims = {
      drive: new Animation(GFX.carDrive, 1, true),
      crash: new Animation(GFX.carCrash, 14, false),
      wreck: new Animation(GFX.carWreck || [GFX.carCrash[GFX.carCrash.length - 1]], 1, true)
    };
    this.anim = this.anims.drive;

    this.wobble = 0;
    this.frozenImg = null;
    this.alpha = 255;

    // crash timeline
    this.crashSlipSign = 1;   // -1 up, +1 down
    this.crashVariant = "d";  // "u" | "d"
    this.crashPhase = 0;      // 0=start, 1=branch, 2=split
    this.crashT = 0;          // frames inside crash
    this.spawnedCrashFrog = false;

    // tow scheduling
    this.towScheduled = false;
    this.towSpawned = false;
    this.towSpawnAtMs = 0;

    // when towed out
    this._towedAway = false;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.anim = this.anims[s];
    this.anim.reset();
  }

  crash() {
    if (this.state === "crash" || this.state === "wreck") return;

    this.setState("crash");

    // slip direction locked for this crash
    this.crashSlipSign = (random() < 0.5) ? -1 : 1; // -1 up, +1 down
    this.wobble = this.crashSlipSign * random(UF(4), UF(7));
    this.crashVariant = (this.crashSlipSign === 1) ? "d" : "u";

    this.speed = max(this.speed, UF(5));

    this.crashPhase = 0;
    this.crashT = 0;
    this.spawnedCrashFrog = false;
    this.frozenImg = null;
  }

  onHit(killedFrog) {
    if (this.state !== "drive") return;
    this.speed *= killedFrog ? 0.86 : 0.95;
  }

  update() {
    this.anim.update();

    if (this.state === "drive") {
      this.pos.x += this.speed * this.dir;
      return;
    }

    // crash / wreck movement
    this.speed *= 0.92;
    this.wobble *= 0.9;
    this.pos.x += this.speed * this.dir;
    this.pos.y += this.wobble;
    this.pos.y = clampWorldY(this.pos.y);

    if (this.state === "crash") {
      this.crashT++;

      // Phase 0: show car_crash_0 briefly
      if (this.crashPhase === 0 && this.crashT > 6) {
        this.crashPhase = 1;
        this.crashT = 0;
      }
      // Phase 1: show car_crash_1u/1d briefly
      else if (this.crashPhase === 1 && this.crashT > 8) {
        this.crashPhase = 2;
        this.crashT = 0;
      }
      // Phase 2: car uses crash_3u/3d, and spawn frog-piece crash_2u/2d once
      else if (this.crashPhase === 2) {
        if (!this.spawnedCrashFrog) {
          this.spawnedCrashFrog = true;

          const frogImg = (this.crashVariant === "u") ? GFX.carCrash2u : GFX.carCrash2d;

          const spawnX = this.pos.x + this.dir * U(10);
          const spawnY = this.pos.y - U(6);

          crashPieces.push(new CrashFrogPiece(spawnX, spawnY, this.dir, frogImg, this.crashVariant));
        }

        if (this.crashT > 18) {
          this.setState("wreck");
          this.frozenImg = (this.crashVariant === "u") ? GFX.carCrash3u : GFX.carCrash3d;

          if (MODE === "animate") scheduleTowForCar(this);
        }
      }
    }
  }

  getAABB() {
    return { x: this.pos.x - this.w / 2, y: this.pos.y - this.h / 2, w: this.w, h: this.h };
  }

  isFarOffscreen() {
    return (
      this.pos.x < -OFFSCREEN_PAD || this.pos.x > width + OFFSCREEN_PAD ||
      this.pos.y < -OFFSCREEN_PAD || this.pos.y > height + OFFSCREEN_PAD
    );
  }

  // helper for still-mode freeze
  getRenderImage() {
    if (this.state === "crash") {
      if (this.crashPhase === 0) return GFX.carCrash0;
      if (this.crashPhase === 1) return (this.crashVariant === "u") ? GFX.carCrash1u : GFX.carCrash1d;
      return (this.crashVariant === "u") ? GFX.carCrash3u : GFX.carCrash3d;
    }
    if (this.state === "wreck" && this.frozenImg) return this.frozenImg;
    return this.anim.frame();
  }

  draw() {
    let img = (MODE === "still" && this.frozenImg) ? this.frozenImg : null;

    if (!img) {
      if (this.state === "crash") {
        if (this.crashPhase === 0) img = GFX.carCrash0;
        else if (this.crashPhase === 1) img = (this.crashVariant === "u") ? GFX.carCrash1u : GFX.carCrash1d;
        else img = (this.crashVariant === "u") ? GFX.carCrash3u : GFX.carCrash3d;
      } else if (this.state === "wreck" && this.frozenImg) {
        img = this.frozenImg;
      } else {
        img = this.anim.frame();
      }
    }

    if (!img) return;

    push();
    translate(this.pos.x, this.pos.y);
    imageMode(CENTER);
    scale(-this.dir, 1);
    tint(255, this.alpha);
    image(img, 0, 0, this.renderW, this.renderH);
    noTint();
    pop();
  }
}
