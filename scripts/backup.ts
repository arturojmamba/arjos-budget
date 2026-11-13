import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, backup } from '../server/db.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb(process.env.FINANCE_DB ?? path.join(root, 'data', 'finance.db'));
console.log('Backup written to', backup(db, process.env.FINANCE_BACKUPS ?? path.join(root, 'data', 'backups')));
db.close();
