"use strict";

/**
 * DIY-ECG Frontend – webgl-plot renderer (Ringbuffer)
 */

/* ==================== Resolve webgl-plot API (SES-safe) ==================== */

let WGP = null;

function resolveWebglPlotApi() {
  if (WGP) return WGP;

  const g = globalThis;

  // Case A: direct globals
  if (g.WebGLPlot && g.WebglLine && g.ColorRGBA) {
    WGP = { Plot: g.WebGLPlot, Line: g.WebglLine, Color: g.ColorRGBA };
    return WGP;
  }
  if (g.WebglPlot && g.WebglLine && g.ColorRGBA) {
    WGP = { Plot: g.WebglPlot, Line: g.WebglLine, Color: g.ColorRGBA };
    return WGP;
  }

  // Case B: bundle namespace
  const b = g.WebglPlotBundle;
  if (b) {
    const api = (b.WebglPlot || b.WebGLPlot) ? b : (b.default ? b.default : null);
    if (api) {
      const PlotCtor = api.WebglPlot || api.WebGLPlot;
      const LineCtor = api.WebglLine;
      const ColorCtor = api.ColorRGBA;
      if (PlotCtor && LineCtor && ColorCtor) {
        WGP = { Plot: PlotCtor, Line: LineCtor, Color: ColorCtor };
        return WGP;
      }
    }
  }

  const keys = Object.keys(g).filter((k) => k.toLowerCase().includes("webgl"));
  throw new Error(
    "webgl-plot API not found. Seen globals: " +
      `WebGLPlot=${typeof g.WebGLPlot}, WebglPlot=${typeof g.WebglPlot}, WebglPlotBundle=${typeof g.WebglPlotBundle}. ` +
      "Matching keys: " + keys.join(", ")
  );
}

function ensureWebglPlotAvailable() {
  resolveWebglPlotApi();
}

/* ==================== DOM ==================== */

const dom = {
  status: document.getElementById("status-text"),
  samples: document.getElementById("sample-count"),
  bpm: document.getElementById("bpm-value"),
  polarity: document.getElementById("polarity-value"),
  samplingRate: document.getElementById("sampling-rate"),
  connection: document.getElementById("connection-indicator"),
  showThreshold: document.getElementById("show-threshold"),
  chart: document.getElementById("ecg-chart"),
  placeholder: document.getElementById("chart-placeholder"),
  filterInputs: document.querySelectorAll("input[data-filter]"),
  clearButton: document.getElementById("clear-buffer"),
  saveButton: document.getElementById("save-buffer"),
  pauseButton: document.getElementById("toggle-pause"),
};

/* ==================== UI helpers ==================== */

function formatSamplingRate(value) {
  if (!Number.isFinite(value)) return "–";
  return `${value.toFixed(1)} Hz`;
}

function updateMetrics(p) {
  dom.status.textContent = p.status ?? "–";
  dom.samples.textContent = p.last_count ?? 0;
  dom.bpm.textContent = p.bpm ?? "–";
  dom.polarity.textContent = p.polarity ?? "–";
  dom.samplingRate.textContent = formatSamplingRate(p.sampling_rate_hz);

  if (p.filters) {
    dom.filterInputs.forEach((input) => {
      const key = input.dataset.filter;
      if (key in p.filters) {
        input.checked = !!p.filters[key];
      }
    });
  }
}

function gatherFilters() {
  const filters = {};
  dom.filterInputs.forEach((input) => {
    filters[input.dataset.filter] = input.checked;
  });
  return filters;
}

/* ==================== Plot config ==================== */

const DRAW_INTERVAL_MS = 100; // 10 Hz UI
const GRID_PX = 100;          // 100 CSS px grid spacing

// Ringbuffer: 200 Hz => 2000 samples ~ 10 s
const RING_CAP = 2000;
let ringY = new Float32Array(RING_CAP);
let ringT = new Uint32Array(RING_CAP); // t_rel in ms (optional, for CSV)
let ringHead = 0; // next write index
let ringLen = 0;  // number of valid samples (<= RING_CAP)

let paused = false;
let pendingSignal = false;
let lastDraw = 0;

// Timing base for ecg_delta decode
let baseT0 = null;

// Threshold from backend meta (optional)
let lastThreshold = null;

// webgl-plot objects
let glPlot = null;
let canvas = null;
let ecgLine = null;
let thrLine = null;
let gridLines = [];

// Resize / iOS orientation handling: soft re-init plot
let resizePending = false;
let lastResizeAt = 0;

// Optional: show y-min/y-max as DOM labels
let yLabels = null;

/* ==================== Generic helpers ==================== */

function cssVar(name, fallback) {
  const rootStyle = getComputedStyle(document.documentElement);
  const v = rootStyle.getPropertyValue(name).trim();
  return v || fallback;
}

function hexToRGBA01(hex, a = 1) {
  const h = (hex || "").replace("#", "").trim();
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return [r / 255, g / 255, b / 255, a];
  }
  if (h.length >= 6) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [r / 255, g / 255, b / 255, a];
  }
  return [1, 1, 1, a];
}

function getChartCssSize() {
  // clientWidth/Height is usually most stable across mobile viewports
  const w = dom.chart.clientWidth || 800;
  const h = dom.chart.clientHeight || 380;
  return { width: w, height: h };
}

/* ==================== Ringbuffer ==================== */

function ringClear() {
  ringHead = 0;
  ringLen = 0;
}

function ringPush(tRelMs, yVal) {
  ringT[ringHead] = tRelMs >>> 0;
  ringY[ringHead] = Number.isFinite(yVal) ? yVal : 0;

  ringHead = (ringHead + 1) % RING_CAP;
  if (ringLen < RING_CAP) ringLen++;
}

// Read nth sample (0..n-1) from the "last n samples", oldest->newest
function ringReadLastN(n, i /* 0..n-1 oldest->newest */) {
  const start = (ringHead - n + RING_CAP) % RING_CAP; // oldest index
  const idx = (start + i) % RING_CAP;
  return { t: ringT[idx], y: ringY[idx] };
}

/* ==================== Y labels (min/max) ==================== */

function ensureYLabels() {
  if (yLabels) return;

  dom.chart.style.position = dom.chart.style.position || "relative";

  const wrap = document.createElement("div");
  wrap.id = "y-labels";
  wrap.style.position = "absolute";
  wrap.style.top = "8px";
  wrap.style.right = "10px";
  wrap.style.bottom = "8px";
  wrap.style.pointerEvents = "none";
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.justifyContent = "space-between";
  wrap.style.alignItems = "flex-end";
  wrap.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  wrap.style.fontSize = "12px";
  wrap.style.lineHeight = "1.1";
  wrap.style.color = "rgba(243, 244, 246, 0.85)";
  wrap.style.textShadow = "0 1px 2px rgba(0,0,0,0.6)";
  wrap.style.zIndex = "4";

  const top = document.createElement("div");
  const bottom = document.createElement("div");
  top.textContent = "–";
  bottom.textContent = "–";

  wrap.appendChild(top);
  wrap.appendChild(bottom);
  dom.chart.appendChild(wrap);

  yLabels = { wrap, top, bottom };
}

function setYLabels(ymin, ymax) {
  ensureYLabels();
  // integer display is usually sufficient for ADC / mV-style signals
  yLabels.top.textContent = Number.isFinite(ymax) ? `${Math.round(ymax)}` : "–";
  yLabels.bottom.textContent = Number.isFinite(ymin) ? `${Math.round(ymin)}` : "–";
}

/* ==================== WebGL plot init / rebuild ==================== */

function removeOldCanvasOnly() {
  const old = document.getElementById("ecg-webgl-canvas");
  if (old) old.remove();
}

function resizeCanvasBackingStore() {
  const dpr = window.devicePixelRatio || 1;
  const sz = getChartCssSize();
  if (!canvas) return { cssW: sz.width, cssH: sz.height, dpr };

  canvas.width = Math.max(1, Math.floor(sz.width * dpr));
  canvas.height = Math.max(1, Math.floor(sz.height * dpr));
  return { cssW: sz.width, cssH: sz.height, dpr };
}

function createWebglLine(color01, nPoints) {
  const api = resolveWebglPlotApi();
  const c = new api.Color(color01[0], color01[1], color01[2], color01[3]);
  const line = new api.Line(c, nPoints);

  const step = nPoints > 1 ? 2 / (nPoints - 1) : 2;
  line.lineSpaceX(-1, step);
  return line;
}

function buildGridLines(gridColor01, dpr) {
  const api = resolveWebglPlotApi();
  const c = new api.Color(gridColor01[0], gridColor01[1], gridColor01[2], gridColor01[3]);

  const spacingPx = GRID_PX * dpr;
  const wPx = canvas.width;
  const hPx = canvas.height;

  const vCount = Math.floor(wPx / spacingPx);
  const hCount = Math.floor(hPx / spacingPx);

  const xPixToNdc = (x) => (x / (wPx - 1)) * 2 - 1;
  const yPixToNdc = (y) => (y / (hPx - 1)) * 2 - 1;

  gridLines = [];

  // Vertical lines
  for (let i = 0; i <= vCount; i++) {
    const xN = xPixToNdc(i * spacingPx);
    const ln = new api.Line(c, 2);
    ln.setX(0, xN);
    ln.setY(0, -1);
    ln.setX(1, xN);
    ln.setY(1, 1);
    gridLines.push(ln);
    glPlot.addLine(ln);
  }

  // Horizontal lines
  for (let j = 0; j <= hCount; j++) {
    const yN = yPixToNdc(j * spacingPx);
    const ln = new api.Line(c, 2);
    ln.setX(0, -1);
    ln.setY(0, yN);
    ln.setX(1, 1);
    ln.setY(1, yN);
    gridLines.push(ln);
    glPlot.addLine(ln);
  }
}

function updateThresholdVisibility() {
  if (!thrLine) return;
  const show = !!(dom.showThreshold && dom.showThreshold.checked && lastThreshold != null);
  const c = thrLine.color;
  c.a = show ? 0.9 : 0.0;
  thrLine.color = c;
}

function initPlotIfNeeded() {
  if (glPlot) return;

  ensureWebglPlotAvailable();
  const api = resolveWebglPlotApi();

  removeOldCanvasOnly();

  // Ensure chart container is positioning context
  dom.chart.style.position = dom.chart.style.position || "relative";

  canvas = document.createElement("canvas");
  canvas.id = "ecg-webgl-canvas";
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  canvas.style.zIndex = "2";

  dom.chart.appendChild(canvas);

  // IMPORTANT: set backing store size BEFORE creating WebGLPlot
  const rs = resizeCanvasBackingStore();

  glPlot = new api.Plot(canvas);

  // Theme colors
  const accentHex = cssVar("--accent", "#2dd4bf");
  const accent = hexToRGBA01(accentHex, 1.0);
  const grid = [1, 1, 1, 0.12];
  const thr = hexToRGBA01("#fbbf24", 0.9);

  // Points = CSS width (1 sample per px if 200 Hz and 5ms/px; still works generally)
  const visiblePoints = Math.max(2, Math.floor(rs.cssW));
  ecgLine = createWebglLine(accent, visiblePoints);
  glPlot.addLine(ecgLine);

  // Threshold line (2 points across x)
  thrLine = new api.Line(new api.Color(thr[0], thr[1], thr[2], thr[3]), 2);
  thrLine.setX(0, -1);
  thrLine.setX(1, 1);
  thrLine.setY(0, 0);
  thrLine.setY(1, 0);
  glPlot.addLine(thrLine);

  // Grid
  buildGridLines(grid, rs.dpr);

  updateThresholdVisibility();
}

function resetPlot() {
  // Soft "re-init": drop plot objects and canvas; keep socket/ring data
  glPlot = null;
  ecgLine = null;
  thrLine = null;
  gridLines = [];
  removeOldCanvasOnly();
  canvas = null;
}

/* ==================== Render scheduling ==================== */

function scheduleRender() {
  pendingSignal = true;
}

function renderLoop(ts) {
  // iOS/Orientation: debounce until viewport settles
  if (resizePending && ts - lastResizeAt > 150) {
    resizePending = false;
    resetPlot();
    scheduleRender();
  }

  if (pendingSignal && ts - lastDraw > DRAW_INTERVAL_MS) {
    drawSignal();
    pendingSignal = false;
    lastDraw = ts;
  }
  requestAnimationFrame(renderLoop);
}

/* ==================== Live draw (Ringbuffer -> WebGL line) ==================== */

function drawSignal() {
  if (paused) return;
  if (ringLen < 2) return;

  initPlotIfNeeded();

  // Ensure ecgLine matches current css width (simple: if mismatch, rebuild plot)
  const cssW = getChartCssSize().width;
  const targetPoints = Math.max(2, Math.floor(cssW));
  if (!ecgLine || ecgLine.numPoints !== targetPoints) {
    // Re-init plot on size mismatch (happens after orientation/viewport changes)
    resetPlot();
    initPlotIfNeeded();
  }

  const nPoints = ecgLine.numPoints;
  const n = Math.min(nPoints, ringLen);

  // Autoscale over last n samples
  let ymin = Infinity;
  let ymax = -Infinity;

  for (let i = 0; i < n; i++) {
    const v = ringReadLastN(n, i).y; // oldest->newest
    if (!Number.isFinite(v)) continue;
    if (v < ymin) ymin = v;
    if (v > ymax) ymax = v;
  }

  if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) return;

  // Padding
  if (ymin === ymax) {
    const d = Math.abs(ymin) || 1;
    ymin -= 0.5 * d;
    ymax += 0.5 * d;
  } else {
    const pad = (ymax - ymin) * 0.12;
    ymin -= pad;
    ymax += pad;
  }

  const span = (ymax - ymin) || 1;

  // Fill ecgLine from left (oldest) to right (newest)
  // Map i (0..nPoints-1) to sample index si (0..n-1)
  const denom = (nPoints > 1) ? (nPoints - 1) : 1;
  const denomS = (n > 1) ? (n - 1) : 1;

  for (let i = 0; i < nPoints; i++) {
    const si = (nPoints === n) ? i : Math.floor((i / denom) * denomS);
    const v = ringReadLastN(n, si).y;
    const yN = ((v - ymin) / span) * 2 - 1;
    ecgLine.setY(i, yN);
  }

  // Threshold line in same scaling
  if (thrLine) {
    if (lastThreshold != null && Number.isFinite(lastThreshold)) {
      const thrN = ((lastThreshold - ymin) / span) * 2 - 1;
      thrLine.setY(0, thrN);
      thrLine.setY(1, thrN);
    } else {
      thrLine.setY(0, 0);
      thrLine.setY(1, 0);
    }
    updateThresholdVisibility();
  }

  // Update y labels
  setYLabels(ymin, ymax);

  // Render
  glPlot.update();

  if (dom.placeholder) dom.placeholder.style.display = "none";
}

/* ==================== Controls ==================== */

function buildCsvFilename() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  return `diy-ecg-buffer-${stamp}.csv`;
}

function buildCsvFromRing(threshold) {
  const lines = ["t_ms,ecg_mv,threshold"];
  const tValue = threshold == null ? "" : String(threshold);

  const n = ringLen;
  if (n === 0) return `${lines.join("\n")}\n`;

  // Linearize from oldest->newest
  for (let i = 0; i < n; i++) {
    const s = ringReadLastN(n, i);
    lines.push(`${s.t},${s.y},${tValue}`);
  }
  return `${lines.join("\n")}\n`;
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function attachControls(socket) {
  dom.filterInputs.forEach((input) => {
    input.addEventListener("change", () => {
      socket.emit("set_filters", gatherFilters());
      // Optional UX: if you want filter changes to be instantly "clean",
      // clear only the displayed buffer (keep backend buffer intact):
      // ringClear(); baseT0 = null; scheduleRender();
    });
  });

  dom.clearButton.addEventListener("click", () => {
    socket.emit("clear_buffer", {});
    baseT0 = null;
    ringClear();
    paused = false;
    dom.pauseButton.textContent = "Pause display";
    lastThreshold = null;

    if (dom.placeholder) dom.placeholder.style.display = "flex";
    if (yLabels) {
      yLabels.top.textContent = "–";
      yLabels.bottom.textContent = "–";
    }
    scheduleRender();
  });

  dom.saveButton.addEventListener("click", () => {
    if (ringLen === 0) {
      window.alert("No buffer data available.");
      return;
    }
    const csv = buildCsvFromRing(lastThreshold);
    const filename = buildCsvFilename();
    downloadCsv(csv, filename);
  });

  dom.pauseButton.addEventListener("click", () => {
    paused = !paused;
    dom.pauseButton.textContent = paused ? "Resume display" : "Pause display";
    if (!paused) scheduleRender();
  });

  dom.showThreshold.addEventListener("change", () => {
    updateThresholdVisibility();
    scheduleRender();
  });
}

/* ==================== Socket boot ==================== */

function boot() {
  const socket = io();
  attachControls(socket);

  socket.on("connect", () => {
    dom.connection.textContent = "Connected";
    dom.connection.classList.add("online");
    socket.emit("request_status", {});
  });

  socket.on("disconnect", () => {
    dom.connection.textContent = "Disconnected";
    dom.connection.classList.remove("online");
    baseT0 = null;
    ringClear();
    // keep plot canvas; it will show placeholder or last render
  });

  socket.on("ecg_meta", (payload) => {
    updateMetrics(payload);
  });

  // Use full frame only to initialize when ring is empty (prevents overwriting newer deltas)
  socket.on("ecg_frame", (payload) => {
    if (!payload || !payload.signal) return;
    if (paused) return;

    if (ringLen === 0) {
      const sig = payload.signal;
      baseT0 = sig.t0 ?? baseT0;

      const tArr = sig.t;
      const yArr = sig.y;
      if (Array.isArray(tArr) && Array.isArray(yArr) && tArr.length === yArr.length) {
        for (let i = 0; i < yArr.length; i++) {
          const tRel = tArr[i] >>> 0;      // assume already relative ms
          ringPush(tRel, Number(yArr[i]));
        }
      }
      lastThreshold = sig.threshold ?? lastThreshold;
      scheduleRender();
    }
  });

  // Incremental updates: payload = { t0, y[], dt[] , threshold? }
  socket.on("ecg_delta", (payload) => {
    if (!payload || !payload.y || !payload.dt) return;
    if (paused) return;

    if (baseT0 == null) baseT0 = payload.t0;

    let acc = payload.t0;
    const yArr = payload.y;
    const dtArr = payload.dt;

    for (let i = 0; i < yArr.length; i++) {
      if (i > 0) acc += dtArr[i];
      const tRel = (acc - baseT0) >>> 0;
      ringPush(tRel, Number(yArr[i]));
    }

    if (payload.threshold != null) lastThreshold = payload.threshold;

    scheduleRender();
  });

  // Resize/orientation: schedule soft plot re-init (iOS safe)
  window.addEventListener("resize", () => {
    resizePending = true;
    lastResizeAt = performance.now();
  });
  window.addEventListener("orientationchange", () => {
    resizePending = true;
    lastResizeAt = performance.now();
  });

  requestAnimationFrame(renderLoop);
}

boot();
