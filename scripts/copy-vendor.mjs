// Copies the WebAssembly runtime for the neural voice (Piper) into public/vendor
// so the app works offline and never depends on third-party CDNs.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'public', 'vendor');
const files = [
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm', 'ort/ort-wasm-simd.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm.wasm', 'ort/ort-wasm.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-threaded.wasm', 'ort/ort-wasm-threaded.wasm'],
  ['node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.wasm', 'piper/piper_phonemize.wasm'],
  ['node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.data', 'piper/piper_phonemize.data'],
];
for (const [src, dst] of files) {
  const from = join(root, src);
  const to = join(out, dst);
  if (!existsSync(from)) throw new Error(`Missing ${src}. Run npm install first.`);
  mkdirSync(join(to, '..'), { recursive: true });
  cpSync(from, to);
}
console.log('vendor files copied to public/vendor');
