import * as path from 'node:path';
import * as os from 'node:os';
import type { CommandRunner } from '../cloudflare/wrangler.js';
import { defaultFileSystem, type FileSystemAdapter } from '../cloudflare/project.js';

export async function checkBrowserHarness(runner: CommandRunner): Promise<boolean> {
  const res = await runner('which', ['browser-harness']);
  return res.exitCode === 0;
}

export async function installBrowserHarness(
  runner: CommandRunner,
): Promise<{ success: boolean; method: string }> {
  const uvCheck = await runner('which', ['uv']);
  if (uvCheck.exitCode === 0) {
    const installRes = await runner('uv', ['tool', 'install', '--python', '3.12', 'browser-harness'], {
      interactive: true,
    });
    if (installRes.exitCode === 0) {
      return { success: true, method: 'uv' };
    }
  }

  const pipCheck = await runner('which', ['pip3']);
  if (pipCheck.exitCode === 0) {
    const pipRes = await runner('pip3', ['install', '--user', 'browser-harness'], {
      interactive: true,
    });
    if (pipRes.exitCode === 0) {
      return { success: true, method: 'pip3' };
    }
  }

  return { success: false, method: 'none' };
}

export async function registerBrowserHarnessSkill(
  runner: CommandRunner,
  projectRoot: string,
  fs: FileSystemAdapter = defaultFileSystem,
): Promise<boolean> {
  const res = await runner('browser-harness', ['skill']);
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    return false;
  }

  const skillContent = res.stdout;
  const workspaceSkillDir = path.join(projectRoot, '.agents', 'skills', 'browser-harness');
  const workspaceSkillPath = path.join(workspaceSkillDir, 'SKILL.md');

  try {
    await fs.writeFile(workspaceSkillPath, skillContent);
  } catch {}

  const homeDir = os.homedir();
  const globalGeminiSkills = path.join(homeDir, '.gemini', 'config', 'skills', 'browser-harness');
  const globalSkillPath = path.join(globalGeminiSkills, 'SKILL.md');

  try {
    await fs.writeFile(globalSkillPath, skillContent);
  } catch {}

  const cliSkills = path.join(homeDir, '.gemini', 'antigravity-cli', 'skills', 'browser-harness');
  const cliSkillPath = path.join(cliSkills, 'SKILL.md');

  try {
    await fs.writeFile(cliSkillPath, skillContent);
  } catch {}

  return true;
}

export async function ensureBrowserHarness(
  runner: CommandRunner,
  projectRoot: string,
  stdout: (msg: string) => void,
  stderr: (msg: string) => void,
  fs: FileSystemAdapter = defaultFileSystem,
): Promise<boolean> {
  const alreadyInstalled = await checkBrowserHarness(runner);
  if (alreadyInstalled) {
    stdout('browser-harness is installed.');
    await registerBrowserHarnessSkill(runner, projectRoot, fs);
    return true;
  }

  stdout('browser-harness not found. Installing via uv/pip...');
  const installResult = await installBrowserHarness(runner);
  if (!installResult.success) {
    stderr('Could not automatically install browser-harness.');
    stderr('Please install it manually with: uv tool install --python 3.12 browser-harness');
    return false;
  }

  stdout(`Successfully installed browser-harness via ${installResult.method}.`);
  stdout('Registering browser-harness agent skill...');
  await registerBrowserHarnessSkill(runner, projectRoot, fs);
  return true;
}
