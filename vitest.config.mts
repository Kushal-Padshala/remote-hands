import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Keep compiled Swift helper binaries (fastExec) out of ~/.remote-hands during tests.
process.env.RH_SWIFT_CACHE_DIR ??= mkdtempSync(join(tmpdir(), 'rh-swift-cache-'));

// Local dev keeps Supabase keys in a git-ignored .env at the repo root; CI exports
// them as real environment variables instead, so a missing file here is expected.
try {
  process.loadEnvFile();
} catch {
  // no .env file present — environment variables are already set (e.g. in CI)
}

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'supabase', 'tests'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/.claude/**'],
  },

});
