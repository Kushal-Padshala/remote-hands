import { promises as nodeFs } from 'node:fs';
import * as path from 'node:path';

export interface FileSystemAdapter {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}

export const defaultFileSystem: FileSystemAdapter = {
  readFile: (p) => nodeFs.readFile(p, 'utf-8'),
  writeFile: async (p, content) => {
    await nodeFs.mkdir(path.dirname(p), { recursive: true });
    await nodeFs.writeFile(p, content, 'utf-8');
  },
  exists: async (p) => {
    try {
      await nodeFs.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

export async function writeWranglerConfig(
  configPath: string,
  options: { dbId: string; dbName: string; r2Bucket?: string | undefined },
  fs: FileSystemAdapter = defaultFileSystem,
): Promise<void> {
  const content = await fs.readFile(configPath);

  let updated = content.replace(
    /"database_id":\s*"[^"]*"/,
    `"database_id": "${options.dbId}"`,
  );
  updated = updated.replace(
    /"database_name":\s*"[^"]*"/,
    `"database_name": "${options.dbName}"`,
  );

  await fs.writeFile(configPath, updated);
}
