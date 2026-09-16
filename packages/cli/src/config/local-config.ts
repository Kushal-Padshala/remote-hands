import * as path from 'node:path';
import * as os from 'node:os';
import { defaultFileSystem, type FileSystemAdapter } from '../cloudflare/project.js';

export interface LocalConfig {
  apiUrl: string;
  sessionToken: string;
  machineId: string;
  ownerSecret?: string | undefined;
}

export function getDefaultConfigDir(): string {
  const home = os.homedir();
  return path.join(home, '.config', 'remote-hands');
}

export async function loadLocalConfig(
  configDir: string = getDefaultConfigDir(),
  fs: FileSystemAdapter = defaultFileSystem,
): Promise<LocalConfig | null> {
  const filePath = path.join(configDir, 'config.json');
  if (!(await fs.exists(filePath))) {
    return null;
  }
  try {
    const raw = await fs.readFile(filePath);
    return JSON.parse(raw) as LocalConfig;
  } catch {
    return null;
  }
}

export async function saveLocalConfig(
  config: LocalConfig,
  configDir: string = getDefaultConfigDir(),
  fs: FileSystemAdapter = defaultFileSystem,
): Promise<void> {
  const filePath = path.join(configDir, 'config.json');
  await fs.writeFile(filePath, JSON.stringify(config, null, 2));
}
