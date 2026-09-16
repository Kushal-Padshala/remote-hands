import { promises as nodeFs } from 'node:fs';

export interface FileSystemAdapter {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}

export const defaultFileSystem: FileSystemAdapter = {
  readFile: (p) => nodeFs.readFile(p, 'utf-8'),
  writeFile: (p, content) => nodeFs.writeFile(p, content, 'utf-8'),
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

  const updated = content.replace(
    /"database_id":\s*"[^"]*"/,
    `"database_id": "${options.dbId}"`,
  );

  await fs.writeFile(configPath, updated);
}
