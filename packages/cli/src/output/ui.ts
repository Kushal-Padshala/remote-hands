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

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function visualWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (const char of clean) {
    const code = char.codePointAt(0);
    if (!code) continue;
    if (
      (code >= 0x2600 && code <= 0x27bf) ||
      (code >= 0x1f300 && code <= 0x1f9ff) ||
      (code >= 0x2b50 && code <= 0x2b55)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function renderBanner(terminalCols?: number): string {
  const cols =
    terminalCols ??
    (typeof process !== 'undefined' && process.stdout && process.stdout.columns
      ? process.stdout.columns
      : 80);

  if (cols < 68) {
    const termWidth = Math.max(36, Math.min(cols, 80));
    const hr = '─'.repeat(termWidth - 2);
    return [
      '',
      c.cyan(`╭─ ${c.bold(c.brightCyan('⚡ Remote Hands'))} ${'─'.repeat(Math.max(2, termWidth - 20))}`),
      `${c.cyan('│')}  ${c.white('Autonomous Agentic Coding Control Plane')}`,
      `${c.cyan('│')}  ${c.dim('Cloudflare Free Tier')} ${c.dim('•')} ${c.green('Zero Cloud Hosting Costs')}`,
      c.cyan(`╰${hr}`),
      '',
    ].join('\n');
  }

  const innerWidth = 63;
  const line1Text = `  ${c.bold(c.brightCyan('⚡ Remote Hands'))}  ${c.dim('•')}  ${c.white('Autonomous Agentic Coding Control Plane')}`;
  const line2Text = `  ${c.dim('Cloudflare Free Tier')}  ${c.dim('•')}  ${c.green('Zero Cloud Hosting Costs')}`;

  const pad1 = Math.max(0, innerWidth - visualWidth(line1Text));
  const pad2 = Math.max(0, innerWidth - visualWidth(line2Text));

  const borderTop = `╭${'─'.repeat(innerWidth)}╮`;
  const borderBot = `╰${'─'.repeat(innerWidth)}╯`;

  return [
    '',
    c.cyan(borderTop),
    `${c.cyan('│')}${line1Text}${' '.repeat(pad1)}${c.cyan('│')}`,
    `${c.cyan('│')}${line2Text}${' '.repeat(pad2)}${c.cyan('│')}`,
    c.cyan(borderBot),
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

export async function renderPairingTui(info: PairingSummaryInfo, terminalCols?: number): Promise<string> {
  const cols =
    terminalCols ??
    (typeof process !== 'undefined' && process.stdout && process.stdout.columns
      ? process.stdout.columns
      : 80);
  const termWidth = Math.max(48, Math.min(cols, 74));
  const hr = '─'.repeat(termWidth - 2);

  let qrLines: string[] = [];
  try {
    const rawQr = await QRCode.toString(info.pairingUrl, {
      type: 'terminal',
      small: true,
      margin: 1,
    });
    qrLines = rawQr
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => `${c.brightGreen('│')}     ${line}`);
  } catch {
    qrLines = [`${c.brightGreen('│')}     ${c.yellow('(QR code generation failed, use link below)')}`];
  }

  const lines = [
    '',
    c.brightGreen(`╭─ ${c.bold('✨ Remote Hands Stack Ready')} ${'─'.repeat(Math.max(2, termWidth - 32))}`),
    `${c.brightGreen('│')}  ${c.dim('Cloudflare Free Tier • Pair your phone to begin')}`,
    c.brightGreen(`├${hr}`),
    c.brightGreen('│'),
    `${c.brightGreen('│')}  ${c.bold(c.brightCyan('📱 SCAN TO OPEN DIRECT PAIRING LINK:'))}`,
    `${c.brightGreen('│')}  ${c.dim('↳ ')}${c.cyan(info.pairingUrl)}`,
    c.brightGreen('│'),
    ...qrLines,
    c.brightGreen('│'),
    c.brightGreen(`├${hr}`),
    c.brightGreen('│'),
    `${c.brightGreen('│')}  ${c.bold(c.white('1. Direct Pairing Link (encoded in QR code above):'))}`,
    `${c.brightGreen('│')}     ${c.brightCyan(info.pairingUrl)}`,
    c.brightGreen('│'),
    `${c.brightGreen('│')}  ${c.bold(c.white('2. Pairing Code:'))}`,
    `${c.brightGreen('│')}     ${c.bold(c.yellow(info.pairingCode))}`,
    c.brightGreen('│'),
    `${c.brightGreen('│')}  ${c.bold(c.white('3. Phone Web App Base URL:'))}`,
    `${c.brightGreen('│')}     ${c.cyan(info.webUrl)}`,
    c.brightGreen('│'),
    `${c.brightGreen('│')}  ${c.bold(c.white('4. Start Local Daemon:'))}`,
    `${c.brightGreen('│')}     ${c.green(info.daemonCommand)}`,
    c.brightGreen('│'),
    `${c.brightGreen('│')}  ${c.dim('💡 Scan the QR above with your phone camera to pair immediately.')}`,
    c.brightGreen('│'),
    c.brightGreen(`╰${hr}`),
    '',
  ];

  return lines.join('\n');
}
