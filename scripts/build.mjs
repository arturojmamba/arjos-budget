// Bundles the React frontend into dist/. `--watch` rebuilds on change.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

fs.mkdirSync(outdir, { recursive: true });
fs.copyFileSync(path.join(root, 'web', 'index.html'), path.join(outdir, 'index.html'));

const options = {
  entryPoints: { main: path.join(root, 'web', 'main.tsx') },
  bundle: true,
  outdir,
  format: 'esm',
  target: ['safari16', 'chrome115', 'firefox115'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
