// Bundles the desktop app's main process (electron/main.ts + the server) into dist-electron/main.mjs.
// The UI is built separately into dist/ by scripts/build.mjs.
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({
  entryPoints: [path.join(root, 'electron', 'main.ts')],
  outfile: path.join(root, 'dist-electron', 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
});
