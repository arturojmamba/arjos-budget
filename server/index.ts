// `npm start`: runs the app from this folder and serves it on http://localhost:4545.
// The desktop app (electron/main.ts) uses the same startServer() with its own data folder.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './start.ts';
import { trading212Config } from './investments.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Secrets (Trading 212 API key) live in .env next to package.json — never in the database or the UI.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const dbFile = process.env.FINANCE_DB ?? path.join(root, 'data', 'finance.db');

const app = await startServer({
  dbFile,
  backupDir: process.env.FINANCE_BACKUPS ?? path.join(root, 'data', 'backups'),
  staticDir: path.join(root, 'dist'),
  port: Number(process.env.PORT ?? 4545),
  host: process.env.HOST ?? '127.0.0.1',
});
console.log(`\n  Finance app running at http://localhost:${app.port}\n  Database: ${dbFile}`);
console.log(`  Trading 212: ${trading212Config() ? 'API key found' : 'not configured (see .env.example)'}\n`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { app.db.close(); process.exit(0); });
}
