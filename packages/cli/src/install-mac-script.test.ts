import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The one-line Mac installer downloads Node.js, so these tests pin what keeps it safe and tidy without running it:
 * valid shell, nothing outside the person's own folder, a checksum before anything is unpacked, and nothing that runs
 * only half of it when the download is cut short.
 */
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'install-mac.sh');
const script = fs.readFileSync(scriptPath, 'utf-8');
const code = script.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('scripts/install-mac.sh', () => {
  it('is valid shell', () => {
    const res = spawnSync('/bin/sh', ['-n', scriptPath], { encoding: 'utf-8' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });

  it('needs no administrator rights', () => {
    expect(code).not.toMatch(/\bsudo\b|\bosascript\b|\/usr\/local\/|\/opt\/homebrew|\bbrew\b|Library\/LaunchDaemons/);
  });

  it('checks what it downloads against the published checksum before unpacking it, over https only', () => {
    expect(code).toContain('SHASUMS256.txt');
    expect(code).toContain('shasum -a 256');
    expect(code.indexOf('shasum -a 256')).toBeLessThan(code.indexOf('tar -xzf'));
    expect(code).toContain('https://nodejs.org/dist/');
    expect(code).not.toMatch(/http:\/\//);
  });

  it('runs nothing until the whole file has arrived (everything is in functions, main is the last line)', () => {
    const lines = script.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('main "$@"');
    const topLevel = lines.filter((l) => l.length > 0 && !/^\s/.test(l) && !l.startsWith('#') && !l.startsWith('}'));
    for (const l of topLevel) expect(l).toMatch(/^(main\(\) \{|node_ok\(\) \{|install_node\(\) \{|write_launchers\(\) \{|add_to_path\(\) \{|main "\$@")$/);
  });

  it('reads the setup answers from the real terminal, since its own input is the download', () => {
    expect(code).toContain('"$NODE_BIN" "$CLI_ENTRY" setup --hud </dev/tty');
    // agy's folder and the private Node's npx are on PATH for it, even on a Mac whose PATH does not list them yet
    expect(code).toContain('PATH="${NODE_DIR}/bin:${BIN_DIR}:${HOME}/.local/bin:${PATH}"');
  });

  it('keeps its own Node and package under ~/.remote-hands and never trusts the machine\'s node or npm settings', () => {
    expect(code).toContain('RH="${HOME}/.remote-hands"');
    expect(code).toContain('install -g "$PACKAGE" --prefix "$NPM_PREFIX"');
    expect(code).toContain('"$NODE_BIN" "$npm_cli" install');
    expect(code).not.toMatch(/command -v (node|npm)|which (node|npm)/);
  });

  it('accepts only a Node that has node:sqlite without a flag (22.13+, 23.4+, 24+)', () => {
    expect(code).toContain('[ "$maj" -eq 22 ] && [ "$min" -ge 13 ]');
    expect(code).toContain('[ "$maj" -eq 23 ] && [ "$min" -ge 4 ]');
    expect(code).toContain('[ "$maj" -ge 24 ]');
  });

  it('adds itself to the shell startup files once, however often it runs', () => {
    expect(code).toContain("grep -Fq '# remote-hands'");
  });

  describe('the launchers it writes, run for real', () => {
    function install(): { home: string; bin: string } {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-mac-'));
      const bin = path.join(home, '.remote-hands', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const fn = script.slice(script.indexOf('write_launchers() {'), script.indexOf('# Puts ~/.remote-hands/bin first on PATH'));
      const res = spawnSync('/bin/sh', ['-c', `HOME='${home}'\nBIN_DIR='${bin}'\n${fn}\nwrite_launchers`], { encoding: 'utf-8' });
      expect(res.status).toBe(0);
      // a stand-in for the private Node that reports how it was started
      const nodeBin = path.join(home, '.remote-hands', 'node', 'bin');
      fs.mkdirSync(nodeBin, { recursive: true });
      fs.writeFileSync(path.join(nodeBin, 'node'), '#!/bin/sh\necho "ARGS:$*"\necho "PATH:$PATH"\n', { mode: 0o755 });
      return { home, bin };
    }

    it('rh and remote-hands pass the arguments straight through, with the private Node first on PATH', () => {
      const { home, bin } = install();
      try {
        for (const name of ['rh', 'remote-hands']) {
          const res = spawnSync(path.join(bin, name), ['doctor', '--x'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' });
          expect(res.stdout).toContain('index.js doctor --x');
          expect(res.stdout).toContain(`PATH:${path.join(home, '.remote-hands', 'node', 'bin')}:`);
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('rh-browser runs the browser command, since the program can no longer tell from its own name', () => {
      const { home, bin } = install();
      try {
        const res = spawnSync(path.join(bin, 'rh-browser'), ['tabs'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' });
        expect(res.stdout).toContain('index.js browser tabs');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe('node_ok version rules, run for real', () => {
    function accepts(version: string): boolean {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-mac-'));
      try {
        const nodeDir = path.join(dir, 'node', 'bin');
        fs.mkdirSync(nodeDir, { recursive: true });
        fs.writeFileSync(path.join(nodeDir, 'node'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
        const fn = script.slice(script.indexOf('node_ok() {'), script.indexOf('# Downloads the newest Node.js'));
        const res = spawnSync('/bin/sh', ['-c', `NODE_BIN='${path.join(nodeDir, 'node')}'\n${fn}\nnode_ok`], { encoding: 'utf-8' });
        return res.status === 0;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    it.each([
      ['v22.13.0', true],
      ['v22.22.0', true],
      ['v22.12.9', false],
      ['v23.3.0', false],
      ['v23.4.0', true],
      ['v24.1.0', true],
      ['v20.19.0', false],
      ['garbage', false],
    ])('%s -> %s', (version, expected) => {
      expect(accepts(version)).toBe(expected);
    });
  });
});
