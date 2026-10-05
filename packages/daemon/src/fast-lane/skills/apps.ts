import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppCatalog } from './types.js';

export interface AppCatalogOptions {
  dirs?: string[] | undefined;
  fs?: Pick<typeof fs, 'readdirSync'> | undefined;
}

const MAX_CANDIDATES = 8;

function normalize(spoken: string): string {
  return spoken.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^the /, '');
}

/** The apps actually installed on this Mac. Only these can ever be opened by name. */
export function createAppCatalog(opts: AppCatalogOptions = {}): AppCatalog {
  const dirs = opts.dirs ?? [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    path.join(os.homedir(), 'Applications'),
  ];
  const reader = opts.fs ?? fs;

  const names = (): string[] => {
    const found = new Set<string>();
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = reader.readdirSync(dir) as unknown as string[];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.endsWith('.app')) found.add(entry.slice(0, -'.app'.length));
      }
    }
    return [...found].sort((a, b) => a.localeCompare(b));
  };

  return {
    names,
    resolve(spoken) {
      const wanted = normalize(spoken);
      if (wanted === '') return null;
      const all = names();
      const exact = all.find((n) => n.toLowerCase() === wanted);
      if (exact !== undefined) return { name: exact };
      const matches = all.filter((n) => n.toLowerCase().startsWith(wanted) || n.toLowerCase().includes(wanted));
      if (matches.length === 0) return null;
      if (matches.length === 1) return { name: matches[0]! };
      return { candidates: matches.slice(0, MAX_CANDIDATES) };
    },
  };
}
