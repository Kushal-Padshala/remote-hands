import { defineConfig } from 'vitest/config';

// Local dev keeps Supabase keys in a git-ignored .env at the repo root; CI exports
// them as real environment variables instead, so a missing file here is expected.
try {
  process.loadEnvFile();
} catch {
  // no .env file present — environment variables are already set (e.g. in CI)
}

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'supabase'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/.claude/**'],
  },

});
