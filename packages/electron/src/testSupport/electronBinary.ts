import { createRequire } from 'node:module';

/**
 * Vitest global setup: makes sure the Electron binary is there before any test worker
 * starts. Since Electron 42 it is no longer downloaded on install but the first time
 * `require('electron')` runs — and the test files that import it run in parallel
 * workers, which would all start that download at once. On Windows they trip over each
 * other's half-extracted files ("failed to create directory …\electron\dist\locales").
 * Requiring it here, once, downloads it before the workers do.
 */
export default function setup(): void {
  createRequire(__filename)('electron');
}
