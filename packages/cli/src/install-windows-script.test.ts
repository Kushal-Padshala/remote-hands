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

  it('installs the published package and hands over to the guided setup', () => {
    expect(code).toContain("$Package = 'remote-hands-cli'");
    expect(code).toContain('install -g $Package');
    expect(code).toContain('setup --hud');
    expect(code).toContain('$MinNodeMajor = 22');
  });

  it('removes npm\'s .ps1 launchers so a default Windows setting does not block the rh command', () => {
    expect(code).toContain('.ps1');
    expect(code).toContain('Remove-Item');
    expect(code).toContain("'rh.cmd'");
  });

  it('stops at the first problem and says it in words', () => {
    expect(code).toContain("$ErrorActionPreference = 'Stop'");
    expect(code).toContain('Set-StrictMode -Version Latest');
    expect(code).toContain('Nothing is broken');
  });
});
