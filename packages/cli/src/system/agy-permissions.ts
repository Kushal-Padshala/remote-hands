import * as os from 'node:os';
import * as path from 'node:path';
import type { FileSystemAdapter } from '../cloudflare/project.js';
import { defaultFileSystem } from '../cloudflare/project.js';

export const STANDARD_AGY_PERMISSIONS = [
  'read_file',
  'read_file(*)',
  'write_file',
  'write_file(*)',
  'edit_file',
  'edit_file(*)',
  'list_dir',
  'list_dir(*)',
  'view_file',
  'view_file(*)',
  'replace_file_content',
  'replace_file_content(*)',
  'multi_replace_file_content',
  'multi_replace_file_content(*)',
  'grep_search',
  'grep_search(*)',
  'run_command',
  'run_command(*)',
  'command(*)',
  'command(python3)',
  'command(python)',
  'command(pip)',
  'command(pip3)',
  'command(uv)',
  'command(uvx)',
  'command(bash)',
  'command(sh)',
  'command(zsh)',
  'command(node)',
  'command(npm)',
  'command(npm install)',
  'command(npm run)',
  'command(npm test)',
  'command(npx)',
  'command(pnpm)',
  'command(yarn)',
  'command(bun)',
  'command(git)',
  'command(ls)',
  'command(cat)',
  'command(echo)',
  'command(find)',
  'command(grep)',
  'command(which)',
  'command(defaults)',
  'command(mkdir)',
  'command(cp)',
  'command(mv)',
  'command(rm)',
  'command(touch)',
  'command(head)',
  'command(tail)',
  'command(curl)',
  'command(tar)',
  'command(unzip)',
  'command(zip)',
  'command(sed)',
  'command(awk)',
  'command(ps)',
  'command(lsof)',
  'command(open)',
  'command(cd)',
  'command(pwd)',
  'command(chmod)',
  'command(chown)',
  'command(export)',
  'command(env)',
  'command(source)',
  'command(brew)',
  'command(apt)',
  'command(apt-get)',
  'command(pod)',
  'command(xcodebuild)',
  'command(cargo)',
  'command(go)',
  'command(make)',
  'command(docker)',
] as const;

export async function checkAgyPermissions(
  fs: FileSystemAdapter = defaultFileSystem,
  workspacePath?: string,
): Promise<boolean> {
  try {
    const settingsPath = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
    if (!(await fs.exists(settingsPath))) {
      return false;
    }
    const raw = await fs.readFile(settingsPath);
    const parsed = JSON.parse(raw);
    const allows = new Set(Array.isArray(parsed?.permissions?.allow) ? parsed.permissions.allow : []);
    if (!allows.has('read_file')) {
      return false;
    }
    if (workspacePath) {
      const trusted = new Set(Array.isArray(parsed?.trustedWorkspaces) ? parsed.trustedWorkspaces : []);
      if (!trusted.has(path.resolve(workspacePath))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function ensureAgyPermissions(
  fs: FileSystemAdapter = defaultFileSystem,
  workspacePath?: string,
): Promise<boolean> {
  try {
    const settingsPath = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
    let settingsObj: any = {};
    if (await fs.exists(settingsPath)) {
      try {
        settingsObj = JSON.parse(await fs.readFile(settingsPath));
      } catch {}
    }

    settingsObj.permissions = settingsObj.permissions || {};
    const existingAllow: string[] = Array.isArray(settingsObj.permissions.allow)
      ? settingsObj.permissions.allow
      : [];
    const mergedAllow = Array.from(new Set([...existingAllow, ...STANDARD_AGY_PERMISSIONS]));
    settingsObj.permissions.allow = mergedAllow;

    const existingWorkspaces: string[] = Array.isArray(settingsObj.trustedWorkspaces)
      ? settingsObj.trustedWorkspaces
      : [];
    const workspacesToAdd = [os.homedir(), process.cwd()];
    if (workspacePath) {
      workspacesToAdd.push(path.resolve(workspacePath));
    }
    const mergedWorkspaces = Array.from(new Set([...existingWorkspaces, ...workspacesToAdd]));
    settingsObj.trustedWorkspaces = mergedWorkspaces;

    await fs.writeFile(settingsPath, JSON.stringify(settingsObj, null, 2));
    return true;
  } catch {
    return false;
  }
}
