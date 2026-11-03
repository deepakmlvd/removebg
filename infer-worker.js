import { preload, removeBackground } from "./vendor/background-removal.mjs";

const PUBLIC_PATH = new URL("./assets/", import.meta.url).href;

// The library memoizes its session per config and keeps the first progress callback,
// so progress is routed through a sink that each job replaces.
let sink = () => {};

function buildConfig(model, device) {
  return {
    publicPath: PUBLIC_PATH,
    debug: false,
    rescale: false,
    device,
    proxyToWorker: false,
    model,
    progress: (key, current, total) => {
      sink(key, current, total);
    },
    output: {
      format: "image/x-rgba8",
      quality: 1,
    },
  };
}

// fp16 is the quick model on WebGPU; the quantized model is the quick one on CPU.
function modelFor(profile, device) {
  if (profile === "detail") return "isnet";
  return device === "gpu" ? "isnet_fp16" : "isnet_quint8";
}

const forceCpu = new URL(self.location.href).searchParams.has("cpu");

const deviceReady = navigator.gpu && !forceCpu
  ? navigator.gpu.requestAdapter().then((adapter) => (adapter ? "gpu" : "cpu")).catch(() => "cpu")
  : Promise.resolve("cpu");

let gpuBroken = false;

const warmed = deviceReady.then(async (device) => {
  sink = (key, current, total) => {
    self.postMessage({ type: "preload", key, current, total, device });
  };
  try {
    await preload(buildConfig(modelFor("fast", device), device));
    self.postMessage({ type: "preload-done", device });
  } catch (error) {
    if (device === "gpu") gpuBroken = true;
    self.postMessage({ type: "preload-error", message: String(error && error.message || error) });
  }
});

self.onmessage = async (event) => {
  const { id, buffer, mime, profile } = event.data;
  const blob = new Blob([buffer], { type: mime || "image/png" });
  const t0 = performance.now();
  const marks = [];
  sink = (key, current, total) => {
    marks.push([key, Math.round(performance.now() - t0)]);
    self.postMessage({ type: "progress", id, key, current, total });
  };

  try {
    marks.push(["start", 0]);
    await warmed;
    marks.push(["warmed", Math.round(performance.now() - t0)]);
    let device = gpuBroken ? "cpu" : await deviceReady;
    let result;
    try {
      result = await removeBackground(blob, buildConfig(modelFor(profile, device), device));
    } catch (error) {
      if (device !== "gpu") throw error;
      self.postMessage({ type: "gpu-error", message: String(error && error.stack || error).slice(0, 600) });
      self.postMessage({ type: "progress", id, key: "compute:cpu-fallback", current: 1, total: 1 });
      gpuBroken = true;
      device = "cpu";
      result = await removeBackground(blob, buildConfig(modelFor(profile, device), device));
    }
    const out = await result.arrayBuffer();
    marks.push(["returned", Math.round(performance.now() - t0)]);
    self.postMessage({ type: "done", id, buffer: out, mime: result.type, device, marks }, [out]);
  } catch (error) {
    self.postMessage({ type: "error", id, message: String(error && error.message || error) });
  }
};
