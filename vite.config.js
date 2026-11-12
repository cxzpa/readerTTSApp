import { defineConfig } from 'vite';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * After the build, write the list of app files into the service worker so
 * the whole app is cached on the first visit, and give the cache a version
 * based on their content so updates replace old files.
 * Neural-voice runtime files (vendor/) are cached when first used instead.
 */
function serviceWorkerPrecache() {
  let outDir;
  return {
    name: 'sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = [];
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(relative(outDir, full).split('\\').join('/'));
        }
      };
      walk(outDir);
      const precache = files.filter((f) => f !== 'sw.js' && !f.startsWith('vendor/')).sort();
      const appHash = createHash('sha256');
      for (const f of precache) appHash.update(f).update(readFileSync(join(outDir, f)));
      // Vendor files are large and change only with a dependency upgrade: name + size is enough.
      const vendorHash = createHash('sha256');
      for (const f of files.filter((f) => f.startsWith('vendor/')).sort()) {
        vendorHash.update(f).update(String(statSync(join(outDir, f)).size));
      }
      const swPath = join(outDir, 'sw.js');
      const sw = readFileSync(swPath, 'utf8')
        .replace("'__VERSION__'", JSON.stringify(appHash.digest('hex').slice(0, 12)))
        .replace("'__VENDOR_VERSION__'", JSON.stringify(vendorHash.digest('hex').slice(0, 12)))
        .replace('/*__PRECACHE__*/ []', JSON.stringify(['./', ...precache.map((f) => `./${f}`)]));
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  // Relative base so the build works from any subpath (e.g. GitHub Pages).
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
  optimizeDeps: { exclude: ['@mintplex-labs/piper-tts-web', 'onnxruntime-web'] },
  plugins: [serviceWorkerPrecache()],
});
