import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

async function copyDirectory(source, target) {
  await fs.cp(source, target, { recursive: true });
}

async function buildScript(sourceName, outputName, replaceWorkerReference = false) {
  let source = await fs.readFile(path.join(root, sourceName), "utf8");
  if (replaceWorkerReference) source = source.replaceAll("./infer-worker.js", "./infer-worker.min.js");
  const minified = await transform(source, {
    loader: "js",
    format: "esm",
    minify: true,
    legalComments: "none",
    target: "es2020",
  });
  const obfuscated = JavaScriptObfuscator.obfuscate(minified.code, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    renameGlobals: false,
    selfDefending: false,
    stringArray: true,
    stringArrayThreshold: 0.75,
    unicodeEscapeSequence: false,
  });
  await fs.writeFile(path.join(dist, outputName), obfuscated.getObfuscatedCode());
}

async function main() {
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });

  let html = await fs.readFile(path.join(root, "index.html"), "utf8");
  html = html
    .replace(/<script type="module" src="app\.js"><\/script>/, '<script type="module" src="app.min.js"></script>')
    .replace("</head>", '  <meta name="robots" content="index, follow" />\n</head>');
  await fs.writeFile(path.join(dist, "index.html"), html);

  const css = await transform(await fs.readFile(path.join(root, "styles.css"), "utf8"), {
    loader: "css",
    minify: true,
  });
  await fs.writeFile(path.join(dist, "styles.min.css"), css.code);
  const builtHtml = html.replace("styles.css", "styles.min.css");
  await fs.writeFile(path.join(dist, "index.html"), builtHtml);

  await buildScript("app.js", "app.min.js", true);
  await buildScript("infer-worker.js", "infer-worker.min.js");
  await copyDirectory(path.join(root, "vendor"), path.join(dist, "vendor"));
  await copyDirectory(path.join(root, "assets"), path.join(dist, "assets"));

  console.log(`Build complete: ${path.relative(root, dist)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
