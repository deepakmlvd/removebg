const STORAGE_KEY = "cutout-session-settings";
const SCALES = [
  { scale: 0.25, label: "Lowest" },
  { scale: 0.5, label: "Small" },
  { scale: 0.75, label: "Medium" },
  { scale: 1, label: "Source" },
  { scale: 1.5, label: "High" },
  { scale: 2, label: "Highest" },
];

const settings = {
  profile: "fast",
  shift: 0,
  feather: 0,
  contrast: 1,
  defringe: 0,
  invert: false,
  bg: "transparent",
  color: "#ffffff",
  color2: "#d6f25c",
  angle: 135,
  blur: 24,
  shadow: false,
  shadowColor: "#000000",
  shadowOpacity: 0.35,
  shadowBlur: 28,
  shadowX: 0,
  shadowY: 18,
  subjectScale: 1,
  offsetX: 0,
  offsetY: 0,
  crop: false,
  padding: 8,
  format: "image/png",
  quality: 0.92,
  tool: "pan",
  brushSize: 28,
  brushHardness: 0.35,
  brushStrength: 0.85,
  compare: 100,
};

const state = {
  image: null,
  bgImage: null,
  fileName: "image",
  mask: null,
  aiMask: null,
  history: [],
  historyIndex: -1,
  bounds: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  space: false,
  painting: false,
  job: 0,
  busy: false,
  worker: null,
  lastDevice: "",
};

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const viewCanvas = $("viewCanvas");
const originalCanvas = $("originalCanvas");
const canvasWrap = $("canvasWrap");

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeName(name) {
  return (name || "image").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_") || "image";
}

function modelFor() {
  return settings.profile;
}

function loadStoredSettings() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const key of Object.keys(settings)) {
      if (key in saved) settings[key] = saved[key];
    }
    if (settings.profile !== "detail") settings.profile = "fast";
  } catch {
    /* ignore broken session data */
  }
}

function saveSettings() {
  const data = JSON.stringify(settings);
  sessionStorage.setItem(STORAGE_KEY, data);
  localStorage.setItem(STORAGE_KEY, data);
}

function setStatus(text) {
  $("status").textContent = text;
}

function formatOut(key, value) {
  if (key === "contrast" || key === "brushHardness" || key === "brushStrength" || key === "quality" || key === "shadowOpacity") {
    return Number(value).toFixed(2);
  }
  if (key === "subjectScale") return `${Math.round(value * 100)}%`;
  if (key === "padding") return `${value}%`;
  if (key === "angle") return `${value}°`;
  return String(value);
}

function bindRange(id, key, onInput) {
  const node = $(id);
  const out = $(`${id}Out`);
  const sync = () => {
    settings[key] = Number(node.value);
    if (out) out.textContent = formatOut(key, settings[key]);
    saveSettings();
    onInput();
  };
  node.value = settings[key];
  if (out) out.textContent = formatOut(key, settings[key]);
  node.addEventListener("input", sync);
}

function applyForm() {
  $("profile").value = settings.profile;
  $("invert").checked = settings.invert;
  $("bg").value = settings.bg;
  $("color").value = settings.color;
  $("color2").value = settings.color2;
  $("shadow").checked = settings.shadow;
  $("shadowColor").value = settings.shadowColor;
  $("crop").checked = settings.crop;
  $("format").value = settings.format;
  $("compare").value = settings.compare;
  updateTools();
  updateBgFields();
  updateFormatFields();
}

function updateTools() {
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.tool === settings.tool);
  });
  viewport.classList.toggle("tool-brush", settings.tool === "erase" || settings.tool === "restore");
  viewport.classList.toggle("tool-pan", settings.tool === "pan");
  if (settings.tool === "pan") $("brushCursor").hidden = true;
}

function updateBgFields() {
  document.querySelectorAll("[data-bg-field]").forEach((el) => {
    el.hidden = !el.dataset.bgField.split(" ").includes(settings.bg);
  });
}

function updateFormatFields() {
  const lossy = settings.format !== "image/png";
  $("qualityRow").hidden = !lossy;
  $("jpegNote").hidden = settings.format !== "image/jpeg";
}

function updateHistoryButtons() {
  $("undoBtn").disabled = state.historyIndex <= 0;
  $("redoBtn").disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
  $("resetBtn").disabled = !state.aiMask;
}

function setBusy(busy) {
  state.busy = busy;
  $("runBtn").disabled = busy || !state.image;
  $("copyBtn").disabled = busy || !state.mask;
  $("progress").hidden = !busy;
  if (busy) $("progress").classList.add("indeterminate");
  updateExportList();
}

function progressLabel(key) {
  if (key.startsWith("fetch:")) return `Downloading ${key.slice(6).replaceAll("_", " ")}`;
  if (key === "compute:inference") return "Removing background";
  if (key === "compute:decode") return "Reading image";
  if (key === "compute:mask") return "Building mask";
  if (key === "compute:encode") return "Packing mask";
  if (key === "compute:cpu-fallback") return "GPU unavailable, switching to CPU";
  return "Working";
}

function getWorker() {
  if (state.worker) return state.worker;
  const forceCpu = new URLSearchParams(location.search).has("cpu") ? "?cpu" : "";
  const worker = new Worker(new URL(`./infer-worker.js${forceCpu}`, import.meta.url), { type: "module" });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (event) => {
    setBusy(false);
    setStatus(event.message || "The local worker failed to start. Use start.ps1 so this page is served over http.");
  };
  state.worker = worker;
  return worker;
}

addEventListener("pagehide", () => {
  state.worker?.terminate();
  state.worker = null;
});

function showStage(hasImage) {
  $("emptyState").hidden = hasImage;
  canvasWrap.hidden = !hasImage;
}

function fitScale() {
  const rect = viewport.getBoundingClientRect();
  if (!viewCanvas.width || !viewCanvas.height) return 1;
  return Math.min((rect.width - 48) / viewCanvas.width, (rect.height - 88) / viewCanvas.height);
}

function applyTransform() {
  const scale = fitScale() * state.zoom;
  canvasWrap.style.transform = `translate(calc(-50% + ${state.panX}px), calc(-50% + ${state.panY}px)) scale(${scale})`;
  $("zoomLabel").textContent = state.zoom === 1 ? "Fit" : `${Math.round(state.zoom * 100)}%`;
}

function applyCompare() {
  const pct = Number(settings.compare);
  originalCanvas.style.clipPath = `inset(0 0 0 ${pct}%)`;
  viewCanvas.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
}

let renderFrame = 0;
function requestRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
}

function getFrame() {
  const width = state.image.naturalWidth;
  const height = state.image.naturalHeight;
  if (!settings.crop || !state.mask) return { sx: 0, sy: 0, sw: width, sh: height };
  if (!state.bounds) state.bounds = computeBounds(state.mask);
  const box = state.bounds;
  const padX = box.w * (settings.padding / 100);
  const padY = box.h * (settings.padding / 100);
  const x = clamp(box.x - padX, 0, width - 1);
  const y = clamp(box.y - padY, 0, height - 1);
  const right = clamp(box.x + box.w + padX, x + 1, width);
  const bottom = clamp(box.y + box.h + padY, y + 1, height);
  return { sx: x, sy: y, sw: right - x, sh: bottom - y };
}

function computeBounds(mask) {
  const ctx = mask.getContext("2d", { willReadFrequently: true });
  const { width, height } = mask;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;
  const step = width * height > 2_000_000 ? 3 : 1;
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      if (data[(row + x) * 4] > 16) {
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return { x: 0, y: 0, w: width, h: height };
  minX = Math.max(0, minX - step);
  minY = Math.max(0, minY - step);
  maxX = Math.min(width - 1, maxX + step);
  maxY = Math.min(height - 1, maxY + step);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

function refineMask(src, { shift, feather, contrast, invert }) {
  if (!invert && shift === 0 && feather < 0.2 && Math.abs(contrast - 1) < 0.02) return src;
  const { canvas, ctx } = makeCanvas(src.width, src.height, true);
  ctx.filter = invert ? "invert(1)" : "none";
  ctx.drawImage(src, 0, 0);
  ctx.filter = "none";

  if (shift !== 0) {
    const radius = Math.min(80, Math.abs(shift));
    const blurred = makeCanvas(src.width, src.height, true);
    blurred.ctx.filter = `blur(${radius}px)`;
    blurred.ctx.drawImage(canvas, 0, 0);
    blurred.ctx.filter = "none";
    const img = blurred.ctx.getImageData(0, 0, src.width, src.height);
    const data = img.data;
    const expand = shift > 0;
    const threshold = expand ? Math.max(8, 40 - radius * 1.1) : Math.min(246, 176 + radius * 1.4);
    const softness = 16;
    for (let i = 0; i < data.length; i += 4) {
      let amount = (data[i] - (threshold - softness)) / (softness * 2);
      amount = clamp(amount, 0, 1);
      const value = Math.round(amount * 255);
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  if (feather >= 0.2) {
    const tmp = makeCanvas(src.width, src.height, false);
    tmp.ctx.filter = `blur(${feather}px)`;
    tmp.ctx.drawImage(canvas, 0, 0);
    ctx.clearRect(0, 0, src.width, src.height);
    ctx.filter = "none";
    ctx.drawImage(tmp.canvas, 0, 0);
  }

  if (Math.abs(contrast - 1) >= 0.02) {
    const img = ctx.getImageData(0, 0, src.width, src.height);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      let amount = (data[i] / 255 - 0.5) * contrast + 0.5;
      amount = clamp(amount, 0, 1);
      const value = Math.round(amount * 255);
      data[i] = data[i + 1] = data[i + 2] = value;
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

function grayToAlpha(gray) {
  const { canvas, ctx } = makeCanvas(gray.width, gray.height);
  const src = gray.getContext("2d");
  const img = src.getImageData(0, 0, gray.width, gray.height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = data[i];
    data[i] = data[i + 1] = data[i + 2] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function harden(gray) {
  const { canvas, ctx } = makeCanvas(gray.width, gray.height, true);
  ctx.drawImage(gray, 0, 0);
  const img = ctx.getImageData(0, 0, gray.width, gray.height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const value = data[i] > 210 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function shadowCss() {
  const hex = settings.shadowColor.replace("#", "");
  const value = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${settings.shadowOpacity})`;
}

function drawBackground(ctx, width, height, frame) {
  if (settings.bg === "transparent") return;
  if (settings.bg === "color") {
    ctx.fillStyle = settings.color;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (settings.bg === "gradient") {
    const rad = (settings.angle * Math.PI) / 180;
    const cx = width / 2;
    const cy = height / 2;
    const len = Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad));
    const dx = Math.cos(rad) * len / 2;
    const dy = Math.sin(rad) * len / 2;
    const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    gradient.addColorStop(0, settings.color);
    gradient.addColorStop(1, settings.color2);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (settings.bg === "blur") {
    ctx.save();
    ctx.filter = `blur(${settings.blur}px)`;
    const pad = settings.blur * 2;
    ctx.drawImage(state.image, frame.sx, frame.sy, frame.sw, frame.sh, -pad, -pad, width + pad * 2, height + pad * 2);
    ctx.restore();
    return;
  }
  if (settings.bg === "image" && state.bgImage) {
    const img = state.bgImage;
    const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
  }
}

function paintSubject(ctx, frame) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const dw = width * settings.subjectScale;
  const dh = height * settings.subjectScale;
  const dx = (width - dw) / 2 + (settings.offsetX / 100) * width;
  const dy = (height - dh) / 2 + (settings.offsetY / 100) * height;
  const placed = makeCanvas(width, height, false);
  placed.ctx.drawImage(state.mask, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, dw, dh);
  const refined = refineMask(placed.canvas, {
    shift: settings.shift * (dw / frame.sw),
    feather: settings.feather * (dw / frame.sw),
    contrast: settings.contrast,
    invert: settings.invert,
  });

  const subject = makeCanvas(width, height, false);
  subject.ctx.drawImage(state.image, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, dw, dh);
  if (settings.defringe > 0) {
    const radius = Math.max(1, settings.defringe * (dw / frame.sw));
    const core = harden(refined);
    const bled = makeCanvas(width, height, false);
    bled.ctx.drawImage(state.image, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, dw, dh);
    bled.ctx.globalCompositeOperation = "destination-in";
    bled.ctx.drawImage(grayToAlpha(core), 0, 0);
    const soft = makeCanvas(width, height, false);
    soft.ctx.filter = `blur(${radius}px)`;
    soft.ctx.drawImage(bled.canvas, 0, 0);
    soft.ctx.filter = "none";
    soft.ctx.globalCompositeOperation = "destination-in";
    soft.ctx.drawImage(grayToAlpha(refined), 0, 0);
    const sharp = makeCanvas(width, height, false);
    sharp.ctx.drawImage(state.image, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, dw, dh);
    sharp.ctx.globalCompositeOperation = "destination-in";
    sharp.ctx.drawImage(grayToAlpha(core), 0, 0);
    subject.ctx.clearRect(0, 0, width, height);
    subject.ctx.drawImage(soft.canvas, 0, 0);
    subject.ctx.drawImage(sharp.canvas, 0, 0);
  } else {
    subject.ctx.globalCompositeOperation = "destination-in";
    subject.ctx.drawImage(grayToAlpha(refined), 0, 0);
  }

  if (settings.shadow) {
    const unit = width / Math.max(frame.sw, 1);
    ctx.save();
    ctx.shadowColor = shadowCss();
    ctx.shadowBlur = settings.shadowBlur * unit;
    ctx.shadowOffsetX = settings.shadowX * unit;
    ctx.shadowOffsetY = settings.shadowY * unit;
    ctx.drawImage(subject.canvas, 0, 0);
    ctx.restore();
  } else {
    ctx.drawImage(subject.canvas, 0, 0);
  }
}

function renderResult(width, height, format = settings.format) {
  const { canvas, ctx } = makeCanvas(width, height, false);
  const frame = getFrame();
  if (format === "image/jpeg" && settings.bg === "transparent") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  } else {
    drawBackground(ctx, width, height, frame);
  }
  if (state.mask) paintSubject(ctx, frame);
  else ctx.drawImage(state.image, frame.sx, frame.sy, frame.sw, frame.sh, 0, 0, width, height);
  return canvas;
}

function previewSize(frame) {
  const maxEdge = 1400;
  const scale = Math.min(1, maxEdge / Math.max(frame.sw, frame.sh));
  return {
    width: Math.max(1, Math.round(frame.sw * scale)),
    height: Math.max(1, Math.round(frame.sh * scale)),
  };
}

function render() {
  if (!state.image) return;
  const frame = getFrame();
  const size = previewSize(frame);
  if (viewCanvas.width !== size.width || viewCanvas.height !== size.height) {
    viewCanvas.width = size.width;
    viewCanvas.height = size.height;
    originalCanvas.width = size.width;
    originalCanvas.height = size.height;
    canvasWrap.style.width = `${size.width}px`;
    canvasWrap.style.height = `${size.height}px`;
  }
  const octx = originalCanvas.getContext("2d");
  octx.clearRect(0, 0, size.width, size.height);
  octx.drawImage(state.image, frame.sx, frame.sy, frame.sw, frame.sh, 0, 0, size.width, size.height);
  const vctx = viewCanvas.getContext("2d");
  vctx.clearRect(0, 0, size.width, size.height);
  const preview = renderResult(size.width, size.height, "image/png");
  vctx.drawImage(preview, 0, 0);
  applyCompare();
  applyTransform();
  $("dims").textContent = `${state.image.naturalWidth} × ${state.image.naturalHeight}`;
}

function outputSize(scale) {
  const frame = state.image ? getFrame() : { sw: 0, sh: 0 };
  let width = Math.max(1, Math.round(frame.sw * scale));
  let height = Math.max(1, Math.round(frame.sh * scale));
  const maxEdge = 8192;
  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const fitted = maxEdge / longest;
    width = Math.max(1, Math.round(width * fitted));
    height = Math.max(1, Math.round(height * fitted));
  }
  return { width, height };
}

function updateExportList() {
  const root = $("exportList");
  root.replaceChildren();
  for (const item of SCALES) {
    const size = state.image ? outputSize(item.scale) : { width: 0, height: 0 };
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "export-link";
    btn.disabled = !state.mask || state.busy;
    const label = document.createElement("span");
    label.textContent = `${item.label} · ${Math.round(item.scale * 100)}%`;
    const dims = document.createElement("strong");
    dims.textContent = size.width ? `${size.width} × ${size.height}` : "—";
    const action = document.createElement("span");
    action.textContent = "Download";
    btn.append(label, dims, action);
    btn.addEventListener("click", () => downloadScale(item.scale));
    root.append(btn);
  }
}

function extFor(format) {
  if (format === "image/jpeg") return "jpg";
  if (format === "image/webp") return "webp";
  return "png";
}

function canvasBlob(canvas, format) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))), format, settings.quality);
  });
}

function saveBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2500);
}

async function downloadScale(scale) {
  if (!state.mask) return;
  const size = outputSize(scale);
  setStatus(`Encoding ${size.width} × ${size.height}…`);
  const canvas = renderResult(size.width, size.height);
  const blob = await canvasBlob(canvas, settings.format);
  saveBlob(blob, `${safeName(state.fileName)}-cutout-${Math.round(scale * 100)}.${extFor(settings.format)}`);
  setStatus(`Saved ${Math.round(scale * 100)}% · ${size.width} × ${size.height}.`);
}

function historyLimit() {
  if (!state.mask) return 4;
  const area = state.mask.width * state.mask.height;
  if (area > 12_000_000) return 2;
  if (area > 6_000_000) return 4;
  return 8;
}

function pushHistory() {
  if (!state.mask) return;
  const copy = document.createElement("canvas");
  copy.width = state.mask.width;
  copy.height = state.mask.height;
  copy.getContext("2d").drawImage(state.mask, 0, 0);
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(copy);
  while (state.history.length > historyLimit()) state.history.shift();
  state.historyIndex = state.history.length - 1;
  updateHistoryButtons();
}

function restoreHistory() {
  const src = state.history[state.historyIndex];
  const ctx = state.mask.getContext("2d");
  ctx.clearRect(0, 0, state.mask.width, state.mask.height);
  ctx.drawImage(src, 0, 0);
  state.bounds = null;
  updateHistoryButtons();
  requestRender();
}

function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1;
  restoreHistory();
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex += 1;
  restoreHistory();
}

function resetMask() {
  if (!state.aiMask || !state.mask) return;
  state.mask.getContext("2d").drawImage(state.aiMask, 0, 0);
  state.bounds = null;
  pushHistory();
  requestRender();
}

function pointerToMask(event) {
  const rect = viewCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * state.mask.width;
  const y = ((event.clientY - rect.top) / rect.height) * state.mask.height;
  const radius = (settings.brushSize / 2) * (state.mask.width / rect.width);
  return { x, y, radius };
}

function eraseAt(x, y, radius) {
  const ctx = state.mask.getContext("2d");
  const gradient = ctx.createRadialGradient(x, y, radius * settings.brushHardness, x, y, radius);
  gradient.addColorStop(0, `rgba(0,0,0,${settings.brushStrength})`);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function restoreAt(x, y, radius) {
  const size = Math.max(2, Math.ceil(radius * 2));
  const stamp = makeCanvas(size, size, false);
  const sx = x - radius;
  const sy = y - radius;
  stamp.ctx.drawImage(state.aiMask, sx, sy, size, size, 0, 0, size, size);
  stamp.ctx.globalCompositeOperation = "destination-in";
  const gradient = stamp.ctx.createRadialGradient(radius, radius, radius * settings.brushHardness, radius, radius, radius);
  gradient.addColorStop(0, `rgba(0,0,0,${settings.brushStrength})`);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  stamp.ctx.fillStyle = gradient;
  stamp.ctx.fillRect(0, 0, size, size);
  state.mask.getContext("2d").drawImage(stamp.canvas, sx, sy);
}

function stampAt(point) {
  if (settings.tool === "restore") restoreAt(point.x, point.y, point.radius);
  else eraseAt(point.x, point.y, point.radius);
}

function strokeTo(point) {
  const dx = point.x - state.lastX;
  const dy = point.y - state.lastY;
  const dist = Math.hypot(dx, dy);
  const step = Math.max(1, point.radius * 0.3);
  const count = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i <= count; i += 1) {
    stampAt({
      x: state.lastX + (dx * i) / count,
      y: state.lastY + (dy * i) / count,
      radius: point.radius,
    });
  }
  state.lastX = point.x;
  state.lastY = point.y;
  state.bounds = null;
  requestRender();
}

function moveBrushCursor(event) {
  const cursor = $("brushCursor");
  const brushing = settings.tool === "erase" || settings.tool === "restore";
  if (!brushing || !state.mask) {
    cursor.hidden = true;
    return;
  }
  const rect = viewCanvas.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  cursor.hidden = !inside;
  cursor.style.width = `${settings.brushSize}px`;
  cursor.style.height = `${settings.brushSize}px`;
  cursor.style.left = `${event.clientX - settings.brushSize / 2}px`;
  cursor.style.top = `${event.clientY - settings.brushSize / 2}px`;
}

async function inferenceBlob(image) {
  const maxEdge = 1024;
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const { canvas, ctx } = makeCanvas(width, height, false);
  ctx.drawImage(image, 0, 0, width, height);
  return canvasBlob(canvas, "image/png");
}

function upscaleAlpha(src, sw, sh, dw, dh) {
  const pixels = sw * sh;
  if (src.length < pixels * 4) throw new Error("The engine returned an incomplete mask.");
  const small = makeCanvas(sw, sh, true);
  const img = new ImageData(sw, sh);
  const data = img.data;
  for (let i = 0, p = 0; i < pixels; i += 1, p += 4) {
    const alpha = src[i * 4 + 3];
    data[p] = data[p + 1] = data[p + 2] = alpha;
    data[p + 3] = 255;
  }
  small.ctx.putImageData(img, 0, 0);
  const full = makeCanvas(dw, dh, true);
  full.ctx.drawImage(small.canvas, 0, 0, dw, dh);
  return full.canvas;
}

async function maskFromResult(buffer, mime, fullW, fullH) {
  if (mime && mime.includes("image/x-rgba8")) {
    const width = Number(/width=(\d+)/.exec(mime)?.[1]);
    const height = Number(/height=(\d+)/.exec(mime)?.[1]);
    if (!width || !height) throw new Error("Mask size was missing from the engine response.");
    return upscaleAlpha(new Uint8Array(buffer), width, height, fullW, fullH);
  }
  const blob = new Blob([buffer], { type: mime || "image/png" });
  const bitmap = await createImageBitmap(blob);
  const full = makeCanvas(fullW, fullH, true);
  full.ctx.drawImage(bitmap, 0, 0, fullW, fullH);
  bitmap.close();
  const img = full.ctx.getImageData(0, 0, fullW, fullH);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    data[i] = data[i + 1] = data[i + 2] = alpha;
    data[i + 3] = 255;
  }
  full.ctx.putImageData(img, 0, 0);
  return full.canvas;
}

async function cutout() {
  if (!state.image || state.busy) return;
  const id = ++state.job;
  const started = performance.now();
  setBusy(true);
  setStatus("Preparing the local cutout…");
  const timer = setInterval(() => {
    if (state.job === id && state.busy) {
      setStatus(`Working locally · ${((performance.now() - started) / 1000).toFixed(0)}s`);
    }
  }, 500);
  try {
    const blob = await inferenceBlob(state.image);
    const buffer = await blob.arrayBuffer();
    state.pending = { id, started, timer };
    getWorker().postMessage({
      id,
      buffer,
      mime: blob.type,
      profile: modelFor(),
    }, [buffer]);
  } catch (error) {
    clearInterval(timer);
    setBusy(false);
    setStatus(error.message || "Could not prepare the image.");
  }
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "gpu-error") {
    console.warn("GPU path failed, using CPU:", msg.message);
    return;
  }
  if (msg.type === "preload" || msg.type === "preload-done" || msg.type === "preload-error" || msg.id === state.job) {
    /* handled below */
  } else {
    return;
  }
  if (msg.type === "preload") {
    if (!state.busy) {
      const pct = msg.total ? Math.round((msg.current / msg.total) * 100) : 0;
      setStatus(`Warming the fast engine${msg.total ? ` · ${pct}%` : ""}…`);
    }
    return;
  }
  if (msg.type === "preload-done") {
    if (!state.busy) setStatus("Fast engine is ready. Open a photo — it never leaves this computer.");
    return;
  }
  if (msg.type === "preload-error") return;
  if (msg.type === "progress") {
    const pct = msg.total ? Math.round((msg.current / msg.total) * 100) : 0;
    $("progress").classList.toggle("indeterminate", !msg.total);
    $("progressBar").style.width = msg.total ? `${pct}%` : "35%";
    setStatus(`${progressLabel(msg.key)}${msg.total ? ` · ${pct}%` : ""}`);
    return;
  }
  if (state.pending) clearInterval(state.pending.timer);
  if (msg.type === "error") {
    setBusy(false);
    setStatus(msg.message);
    return;
  }
  maskFromResult(msg.buffer, msg.mime, state.image.naturalWidth, state.image.naturalHeight)
    .then((mask) => {
      if (msg.id !== state.job) return;
      state.mask = mask;
      state.aiMask = document.createElement("canvas");
      state.aiMask.width = mask.width;
      state.aiMask.height = mask.height;
      state.aiMask.getContext("2d").drawImage(mask, 0, 0);
      state.history = [];
      state.historyIndex = -1;
      state.bounds = null;
      state.lastDevice = msg.device;
      pushHistory();
      const seconds = (performance.now() - state.pending.started) / 1000;
      setStatus(`Transparent cutout ready in ${seconds.toFixed(1)}s. Refine the edge or download a size.`);
      settings.compare = 100;
      $("compare").value = "100";
      setBusy(false);
      updateExportList();
      requestRender();
    })
    .catch((error) => {
      setBusy(false);
      setStatus(error.message || "Could not read the mask.");
    });
}

function loadImage(img, name) {
  state.image = img;
  state.fileName = name || "image";
  state.mask = null;
  state.aiMask = null;
  state.history = [];
  state.historyIndex = -1;
  state.bounds = null;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  showStage(true);
  $("runBtn").disabled = false;
  updateHistoryButtons();
  updateExportList();
  render();
  cutout();
}

function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Choose a PNG, JPEG, or WebP image.");
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    loadImage(img, file.name);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus("Could not read that image.");
  };
  img.src = url;
}

function applyPreset(name) {
  const presets = {
    transparent: { bg: "transparent", shadow: false },
    white: { bg: "color", color: "#ffffff", shadow: true, shadowOpacity: 0.28, shadowY: 16 },
    gray: { bg: "color", color: "#eceae4", shadow: true },
    black: { bg: "color", color: "#111111", shadow: false },
    studio: { bg: "gradient", color: "#f3efe8", color2: "#cfc6ba", angle: 160, shadow: true },
    dusk: { bg: "gradient", color: "#1b2430", color2: "#c98462", angle: 140, shadow: false },
    blur: { bg: "blur", blur: 28 },
    shop: { bg: "color", color: "#ffffff", shadow: true, crop: true, padding: 8, shadowY: 18 },
  };
  Object.assign(settings, presets[name]);
  saveSettings();
  applyForm();
  bindAllRanges();
  requestRender();
}

function bindAllRanges() {
  const ranges = [
    ["shift", "shift"],
    ["feather", "feather"],
    ["contrast", "contrast"],
    ["defringe", "defringe"],
    ["brushSize", "brushSize"],
    ["brushHardness", "brushHardness"],
    ["brushStrength", "brushStrength"],
    ["subjectScale", "subjectScale"],
    ["offsetX", "offsetX"],
    ["offsetY", "offsetY"],
    ["padding", "padding"],
    ["angle", "angle"],
    ["blur", "blur"],
    ["shadowOpacity", "shadowOpacity"],
    ["shadowBlur", "shadowBlur"],
    ["shadowX", "shadowX"],
    ["shadowY", "shadowY"],
    ["quality", "quality"],
  ];
  for (const [id, key] of ranges) {
    const node = $(id);
    const out = $(`${id}Out`);
    node.value = settings[key];
    if (out) out.textContent = formatOut(key, settings[key]);
  }
}

function isTyping(event) {
  const target = event.target;
  return target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
}

function wire() {
  if (location.protocol === "file:") $("fileBanner").hidden = false;
  loadStoredSettings();
  applyForm();
  bindAllRanges();
  for (const [id, key] of [
    ["shift", "shift"], ["feather", "feather"], ["contrast", "contrast"], ["defringe", "defringe"],
    ["brushSize", "brushSize"], ["brushHardness", "brushHardness"], ["brushStrength", "brushStrength"],
    ["subjectScale", "subjectScale"], ["offsetX", "offsetX"], ["offsetY", "offsetY"], ["padding", "padding"],
    ["angle", "angle"], ["blur", "blur"], ["shadowOpacity", "shadowOpacity"], ["shadowBlur", "shadowBlur"],
    ["shadowX", "shadowX"], ["shadowY", "shadowY"], ["quality", "quality"],
  ]) {
    bindRange(id, key, () => {
      if (id === "padding") {
        state.bounds = null;
        updateExportList();
      }
      requestRender();
    });
  }

  $("openBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", () => {
    const file = $("fileInput").files[0];
    if (file) loadFile(file);
    $("fileInput").value = "";
  });
  $("runBtn").addEventListener("click", cutout);
  $("profile").addEventListener("change", () => {
    settings.profile = $("profile").value;
    saveSettings();
  });
  $("invert").addEventListener("change", () => {
    settings.invert = $("invert").checked;
    saveSettings();
    requestRender();
  });
  $("crop").addEventListener("change", () => {
    settings.crop = $("crop").checked;
    state.bounds = null;
    saveSettings();
    updateExportList();
    requestRender();
  });
  $("bg").addEventListener("change", () => {
    settings.bg = $("bg").value;
    saveSettings();
    updateBgFields();
    requestRender();
  });
  $("color").addEventListener("input", () => {
    settings.color = $("color").value;
    saveSettings();
    requestRender();
  });
  $("color2").addEventListener("input", () => {
    settings.color2 = $("color2").value;
    saveSettings();
    requestRender();
  });
  $("shadow").addEventListener("change", () => {
    settings.shadow = $("shadow").checked;
    saveSettings();
    requestRender();
  });
  $("shadowColor").addEventListener("input", () => {
    settings.shadowColor = $("shadowColor").value;
    saveSettings();
    requestRender();
  });
  $("format").addEventListener("change", () => {
    settings.format = $("format").value;
    saveSettings();
    updateFormatFields();
  });
  $("bgFile").addEventListener("change", () => {
    const file = $("bgFile").files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      state.bgImage = img;
      settings.bg = "image";
      $("bg").value = "image";
      saveSettings();
      updateBgFields();
      requestRender();
    };
    img.src = url;
  });
  $("swatches").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-preset]");
    if (btn) applyPreset(btn.dataset.preset);
  });
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.tool = btn.dataset.tool;
      saveSettings();
      updateTools();
    });
  });
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("resetBtn").addEventListener("click", resetMask);
  $("compare").addEventListener("input", () => {
    settings.compare = Number($("compare").value);
    applyCompare();
  });
  $("zoomIn").addEventListener("click", () => {
    state.zoom = Math.min(8, state.zoom * 1.15);
    applyTransform();
  });
  $("zoomOut").addEventListener("click", () => {
    state.zoom = Math.max(0.2, state.zoom / 1.15);
    applyTransform();
  });
  $("fitBtn").addEventListener("click", () => {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyTransform();
  });
  $("copyBtn").addEventListener("click", async () => {
    try {
      const size = outputSize(1);
      const canvas = renderResult(size.width, size.height, "image/png");
      const blob = await canvasBlob(canvas, "image/png");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus("Copied a source-size PNG.");
    } catch {
      setStatus("Clipboard copy was blocked. Use a download button instead.");
    }
  });

  viewport.addEventListener("wheel", (event) => {
    if (!state.image) return;
    event.preventDefault();
    state.zoom = clamp(state.zoom * (event.deltaY < 0 ? 1.08 : 0.92), 0.2, 8);
    applyTransform();
  }, { passive: false });

  viewport.addEventListener("pointerdown", (event) => {
    if (!state.image) return;
    const brushing = (settings.tool === "erase" || settings.tool === "restore") && state.mask && !state.space && event.button === 0;
    if (brushing) {
      viewport.setPointerCapture(event.pointerId);
      state.painting = true;
      const point = pointerToMask(event);
      state.lastX = point.x;
      state.lastY = point.y;
      stampAt(point);
      state.bounds = null;
      requestRender();
      return;
    }
    if (event.button === 1 || (event.button === 0 && (settings.tool === "pan" || state.space))) {
      state.panning = true;
      state.panOrigin = { x: event.clientX - state.panX, y: event.clientY - state.panY };
      viewport.setPointerCapture(event.pointerId);
    }
  });
  viewport.addEventListener("pointermove", (event) => {
    moveBrushCursor(event);
    if (state.painting && state.mask) {
      strokeTo(pointerToMask(event));
      return;
    }
    if (state.panning) {
      state.panX = event.clientX - state.panOrigin.x;
      state.panY = event.clientY - state.panOrigin.y;
      applyTransform();
    }
  });
  const endPointer = () => {
    if (state.painting) pushHistory();
    state.painting = false;
    state.panning = false;
  };
  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);
  viewport.addEventListener("pointerleave", () => { $("brushCursor").hidden = true; });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("dragover");
  });
  window.addEventListener("dragleave", () => document.body.classList.remove("dragover"));
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    document.body.classList.remove("dragover");
    const file = event.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  window.addEventListener("paste", (event) => {
    const item = [...event.clipboardData.items].find((entry) => entry.type.startsWith("image/"));
    if (item) loadFile(item.getAsFile());
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !isTyping(event)) {
      event.preventDefault();
      state.space = true;
      viewport.classList.add("space-pan");
    }
    if (isTyping(event)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if ((event.ctrlKey || event.metaKey) && key === "y") {
      event.preventDefault();
      redo();
    } else if ((event.ctrlKey || event.metaKey) && key === "s") {
      event.preventDefault();
      downloadScale(1);
    } else if (event.key === "[") {
      settings.brushSize = clamp(settings.brushSize - 4, 4, 180);
      bindAllRanges();
      saveSettings();
    } else if (event.key === "]") {
      settings.brushSize = clamp(settings.brushSize + 4, 4, 180);
      bindAllRanges();
      saveSettings();
    } else if (key === "e") {
      settings.tool = "erase";
      updateTools();
    } else if (key === "r") {
      settings.tool = "restore";
      updateTools();
    } else if (key === "h") {
      settings.tool = "pan";
      updateTools();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      state.space = false;
      viewport.classList.remove("space-pan");
    }
  });
  window.addEventListener("resize", applyTransform);
  updateExportList();
  if (location.protocol !== "file:") getWorker();
  setStatus("Ready. Open a photo — the cutout stays on this computer.");
}

wire();
