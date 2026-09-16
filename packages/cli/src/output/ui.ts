import QRCode from 'qrcode';
import type { PairingSummaryInfo } from './messages.js';

export const isColorSupported = Boolean(
  process.stdout.isTTY &&
    (!('NO_COLOR' in process.env) || process.env.NO_COLOR === '0') &&
    (process.env.TERM !== 'dumb' || Boolean(process.env.CI)),
);

export const c = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: (s: string) => (isColorSupported ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (isColorSupported ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s: string) => (isColorSupported ? `\x1b[36m${s}\x1b[39m` : s),
  brightCyan: (s: string) => (isColorSupported ? `\x1b[96m${s}\x1b[39m` : s),
  magenta: (s: string) => (isColorSupported ? `\x1b[35m${s}\x1b[39m` : s),
  brightMagenta: (s: string) => (isColorSupported ? `\x1b[95m${s}\x1b[39m` : s),
  green: (s: string) => (isColorSupported ? `\x1b[32m${s}\x1b[39m` : s),
  brightGreen: (s: string) => (isColorSupported ? `\x1b[92m${s}\x1b[39m` : s),
  yellow: (s: string) => (isColorSupported ? `\x1b[33m${s}\x1b[39m` : s),
  blue: (s: string) => (isColorSupported ? `\x1b[34m${s}\x1b[39m` : s),
  gray: (s: string) => (isColorSupported ? `\x1b[90m${s}\x1b[39m` : s),
  white: (s: string) => (isColorSupported ? `\x1b[97m${s}\x1b[39m` : s),
  bgCyan: (s: string) => (isColorSupported ? `\x1b[46m\x1b[30m${s}\x1b[0m` : s),
  bgMagenta: (s: string) => (isColorSupported ? `\x1b[45m\x1b[37m${s}\x1b[0m` : s),
  bgGreen: (s: string) => (isColorSupported ? `\x1b[42m\x1b[30m${s}\x1b[0m` : s),
};

export function renderBanner(): string {
  const line1 = '╭─────────────────────────────────────────────────────────────────╮';
  const line2 = `│  ${c.bold(c.brightCyan('⚡ Remote Hands'))}  ${c.dim('•')}  ${c.white('Autonomous Agentic Coding Control Plane')}   │`;
  const line3 = `│  ${c.dim('Cloudflare Free Tier')}  ${c.dim('•')}  ${c.green('Zero Cloud Hosting Costs')}                 │`;
  const line4 = '╰─────────────────────────────────────────────────────────────────╯';

  return [
    '',
    c.cyan(line1),
    line2,
    line3,
    c.cyan(line4),
    '',
  ].join('\n');
}

export function renderStepStart(step: number, total: number, title: string): string {
  return `${c.cyan('╭─')} ${c.bold(c.cyan(`[${step}/${total}]`))} ${c.bold(c.white(title))}`;
}

export function renderStepInfo(msg: string): string {
  return `${c.cyan('│')}  ${c.gray('↳')} ${msg}`;
}

export function renderStepAction(msg: string): string {
  return `${c.cyan('│')}  ${c.yellow('⚡')} ${c.yellow(msg)}`;
}

export function renderStepSuccess(msg: string): string {
  return `${c.cyan('╰─')} ${c.brightGreen('✔')} ${c.green(msg)}\n`;
}

export function renderStepError(msg: string): string {
  return `${c.cyan('╰─')} ${c.yellow('✖')} ${msg}\n`;
}

export async function renderPairingTui(info: PairingSummaryInfo): Promise<string> {
  let qrBlock = '';
  try {
    const rawQr = await QRCode.toString(info.pairingUrl, {
      type: 'terminal',
      small: true,
      margin: 1,
    });
    qrBlock = rawQr
      .split('\n')
      .map((line) => `     ${line}`)
      .join('\n');
  } catch {
    qrBlock = `     ${c.yellow('(QR code generation failed, use link below)')}`;
  }

  const borderTop = '╭─────────────────────────────────────────────────────────────────╮';
  const borderMid = '├─────────────────────────────────────────────────────────────────┤';
  const borderBot = '╰─────────────────────────────────────────────────────────────────╯';

  const lines = [
    '',
    c.brightGreen(borderTop),
    `│  ${c.bold(c.brightGreen('✨ REMOTE HANDS STACK READY'))}  ${c.dim('•')}  ${c.white('Pair Your Phone')}                  │`,
    c.brightGreen(borderMid),
    '│                                                                 │',
    `│  ${c.bold(c.brightCyan('📱 SCAN QR CODE WITH YOUR PHONE CAMERA:'))}                          │`,
    '│                                                                 │',
    qrBlock,
    '│                                                                 │',
    c.brightGreen(borderMid),
    '│                                                                 │',
    `│  ${c.bold(c.white('1. Open Phone Web App:'))}                                            │`,
    `│     ${c.cyan(info.webUrl)}`,
    '│                                                                 │',
    `│  ${c.bold(c.white('2. Direct Pairing Link:'))}                                           │`,
    `│     ${c.brightCyan(info.pairingUrl)}`,
    '│                                                                 │',
    `│  ${c.bold(c.white('3. Pairing Code:'))}                                                  │`,
    `│     ${c.bold(c.yellow(info.pairingCode))}`,
    '│                                                                 │',
    `│  ${c.bold(c.white('4. Start Local Daemon:'))}                                            │`,
    `│     ${c.green(info.daemonCommand)}`,
    '│                                                                 │',
    `│  ${c.dim('💡 Run the daemon command above to begin processing tasks.')}        │`,
    '│                                                                 │',
    c.brightGreen(borderBot),
    '',
  ];

  return lines.join('\n');
}
