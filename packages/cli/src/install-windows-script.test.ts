import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The one-line Windows installer cannot be run here, so these tests pin the properties that keep it safe and easy:
 * plain ASCII (PowerShell 5.1 reads an unmarked file as ANSI), no administrator step, a checksum on what it downloads,
 * and no `exit` (which would close the window a person pasted it into).
 */
const script = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'install-windows.ps1'), 'utf-8');
const code = script.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('scripts/install-windows.ps1', () => {
  it('is plain ASCII', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\u0000-\u007f]/.test(script)).toBe(false);
  });

  it('needs no administrator rights and changes no security setting', () => {
    expect(code).not.toMatch(/RunAs|Start-Process[^\n]*-Verb|Set-ExecutionPolicy|\bwinget\b|msiexec|\.msi\b|HKLM:|-Scope\s+(Machine|AllUsers)/i);
    expect(code).toContain("'User')");
  });

  it('checks what it downloads against the published checksum before installing it', () => {
    expect(code).toContain('SHASUMS256.txt');
    expect(code).toContain('Get-FileHash');
    expect(code.indexOf('Get-FileHash')).toBeLessThan(code.indexOf('Expand-Archive'));
    expect(code).toContain('https://nodejs.org/dist/');
    expect(code).not.toMatch(/http:\/\//);
  });

  it('never closes the window it was pasted into', () => {
    expect(code).not.toMatch(/\bexit\b/i);
    expect(code).toMatch(/try\s*{\s*Install-RemoteHands/);
  });

  it('installs the published package into its own folder, never relying on any npm setting or the machine\'s Node', () => {
    expect(code).toContain("$Package = 'remote-hands-cli'");
    expect(code).toContain('install -g $Package --prefix $NpmPrefix');
    expect(code).not.toMatch(/config get prefix/);
    expect(code).toContain("$NodeDir = Join-Path $Home_ 'node'");
    // npm is run with the private Node, not whatever `npm` is first on PATH
    expect(code).toContain('& $NodeExe $npmCli install');
    expect(code).not.toMatch(/Get-Command\s+(node|npm)/i);
  });

  it('accepts only a Node that has node:sqlite without a flag (22.13+, 23.4+, 24+)', () => {
    expect(code).toContain('if ($major -eq 22) { return ($minor -ge 13) }');
    expect(code).toContain('if ($major -eq 23) { return ($minor -ge 4) }');
    expect(code).toContain('if ($major -ge 24) { return $true }');
    expect(code).toContain('Test-NodeVersion $_.version');
  });

  it('makes launchers bound to that Node, first on PATH, in plain ASCII with the folders spelled as %LOCALAPPDATA%', () => {
    expect(code).toContain('"%LOCALAPPDATA%\\remote-hands\\node\\node.exe"');
    expect(code).toContain('remote-hands\\npm\\node_modules\\remote-hands-cli\\dist\\index.js" %*');
    expect(code).toContain("@('rh', 'remote-hands', 'rh-browser')");
    expect(code).toContain('[Text.Encoding]::ASCII');
    expect(code).toContain('Add-ToUserPathFirst $BinDir');
    expect(code).toContain('@($Folder) + $parts');
  });

  it('warns when an older rh in the machine-wide PATH would be found first, and shows the command that always works', () => {
    expect(code).toContain("GetEnvironmentVariable('Path', 'Machine')");
    expect(code).toContain('Test-LauncherShadow');
    expect(code).toContain('Another rh command exists');
  });

  it('hands over to the guided setup with the private Node directly, so PATH does not matter', () => {
    expect(code).toContain('& $NodeExe $CliEntry setup --hud');
  });

  it('stops at the first problem and says it in words', () => {
    expect(code).toContain("$ErrorActionPreference = 'Stop'");
    expect(code).toContain('Set-StrictMode -Version Latest');
    expect(code).toContain('Nothing is broken');
  });
});
