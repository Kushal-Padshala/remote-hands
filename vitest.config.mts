import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Keep compiled Swift helper binaries (fastExec) out of ~/.remote-hands during tests. The
// directory is stable across runs (entries are keyed by template hash, so stale ones are
// harmless) so a full run does not recompile every template or leak a temp dir per run.
process.env.RH_SWIFT_CACHE_DIR ??= join(tmpdir(), 'rh-swift-cache-vitest');

// Code under test writes to ~/.remote-hands and ~/.gemini/*/settings.json (agy permissions,
// local.db, pairing token, HUD helper). Point the home directory at a throwaway one so a test
// run never edits the developer's real config. os.homedir() reads HOME (USERPROFILE on Windows).
const testHome = mkdtempSync(join(tmpdir(), 'rh-vitest-home-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

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
