// One-time setup: mirrors the model weights and ONNX runtime so Cutout runs fully offline.
// Usage: node setup.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const MODEL_BASE = "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
const ORT_FILES = ["ort.bundle.min.mjs", "ort.webgpu.bundle.min.mjs"];
const curl = process.platform === "win32" ? "curl.exe" : "curl";

async function download(url, dest, expectedSize) {
  if (fs.existsSync(dest) && (!expectedSize || fs.statSync(dest).size === expectedSize)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await run(curl, ["-fsSL", "--retry", "3", "-o", tmp, url], { maxBuffer: 1 << 20 });
  const size = fs.statSync(tmp).size;
  if (expectedSize && size !== expectedSize) throw new Error(`${url}: expected ${expectedSize} bytes, got ${size}`);
  fs.renameSync(tmp, dest);
  return true;
}

async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

const assets = path.join(root, "assets");
await download(`${MODEL_BASE}resources.json`, path.join(assets, "resources.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(assets, "resources.json"), "utf8"));

const jobs = [];
for (const entry of Object.values(manifest)) {
  for (const chunk of entry.chunks) {
    jobs.push({ url: MODEL_BASE + chunk.name, dest: path.join(assets, chunk.name), size: chunk.offsets[1] - chunk.offsets[0] });
  }
}
for (const file of ORT_FILES) {
  jobs.push({ url: ORT_BASE + file, dest: path.join(root, "vendor", file) });
}

let done = 0;
await pool(jobs, 8, async (job) => {
  await download(job.url, job.dest, job.size);
  done += 1;
  if (done % 20 === 0 || done === jobs.length) console.log(`${done}/${jobs.length} files`);
});
console.log("Setup complete. Cutout now runs without internet access.");
