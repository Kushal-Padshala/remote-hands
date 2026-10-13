// Developer check for the Windows HUD (src/desktop/windows-hud). Needs the .NET SDK (`dotnet`); not part of the Windows build.
//  1. compiles both C# files as C# 5 against .NET Framework 4.8 (what csc.exe on Windows is), warnings as errors;
//  2. runs the logic tests (JSON, protocol, window state) on this computer.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const check = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'desktop', 'windows-hud', 'check');
const dotnet = [process.env.DOTNET, join(homedir(), '.dotnet', 'dotnet'), 'dotnet'].find((c) => c && (c === 'dotnet' || existsSync(c)));
if (!dotnet || spawnSync(dotnet, ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('The .NET SDK (dotnet) is needed for this check: https://dotnet.microsoft.com/download');
  process.exit(2);
}
const run = (args, label) => {
  console.log(`> ${label}`);
  const res = spawnSync(dotnet, args, { cwd: check, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`FAILED: ${label}`);
    process.exit(res.status ?? 1);
  }
};
run(['build', 'ui-compile.csproj', '-c', 'Release', '--nologo', '-v', 'q'], 'compile the HUD as C# 5 / .NET Framework 4.8');
run(['run', '--project', 'logic-tests.csproj', '--nologo', '-v', 'q'], 'logic tests');
console.log('Windows HUD checks passed');
