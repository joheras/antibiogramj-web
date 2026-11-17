// Vite plugin for the installable (PWA) in-browser version: adds the manifest and icon links
// to index.html and writes sw.js with the list of every built file and a version hash.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

const HEAD = `
    <link rel="manifest" href="manifest.webmanifest" />
    <link rel="icon" type="image/png" href="icons/favicon-48.png" />
    <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />
    <meta name="theme-color" content="#0f766e" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="AntibiogramJ" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="description" content="Measure disk-diffusion antibiograms from a photo of the plate, entirely in the browser." />
  `;

function walk(dir: string, root = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, root) : [path.relative(root, p).split(path.sep).join("/")];
  });
}

export default function pwa(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "antibiogramj-pwa",
    apply: "build",
    configResolved(c) { config = c; },
    transformIndexHtml(html) {
      return html.replace("</head>", `${HEAD}</head>`);
    },
    closeBundle() {
      const out = path.resolve(config.root, config.build.outDir);
      const files = walk(out).filter((f) => f !== "sw.js" && !f.endsWith(".map")).sort();
      const hash = createHash("sha256");
      for (const f of files) hash.update(f).update(fs.readFileSync(path.join(out, f)));
      const version = hash.digest("hex").slice(0, 12);
      const src = fs.readFileSync(path.resolve(config.root, "pwa/sw.js"), "utf8");
      fs.writeFileSync(path.join(out, "sw.js"),
        src.replace('"__VERSION__"', JSON.stringify(version)).replace("__FILES__", JSON.stringify(files, null, 1)));
      const kb = files.reduce((s, f) => s + fs.statSync(path.join(out, f)).size, 0) / 1024;
      config.logger.info(`sw.js: ${files.length} files precached (${(kb / 1024).toFixed(1)} MB), version ${version}`);
    },
  };
}
