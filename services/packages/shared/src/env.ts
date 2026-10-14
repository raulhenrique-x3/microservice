import path from 'node:path';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';

/**
 * Loads the closest .env walking up from cwd (the repository root holds it),
 * so entries work identically from repo, container or any app directory.
 */
export function loadDotEnv() {
  let dir = process.cwd();
  for (;;) {
    const p = path.join(dir, '.env');
    if (existsSync(p)) {
      dotenv.config({ path: p });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      dotenv.config();
      return;
    }
    dir = parent;
  }
}
