export interface PairingSummaryInfo {
  webUrl: string;
  pairingUrl: string;
  pairingCode: string;
  daemonCommand: string;
}

export function formatPairingSummary(info: PairingSummaryInfo): string {
  return [
    '======================================================',
    '       Remote Hands Free Stack Deployed Successfully  ',
    '======================================================',
    '',
    '1. Open the Phone Web App:',
    `   ${info.webUrl}`,
    '',
    '2. Pair your phone using this link or code:',
    `   Pairing Code: ${info.pairingCode}`,
    `   Pairing URL:  ${info.pairingUrl}`,
    '',
    '3. Start the daemon on this computer to listen for tasks:',
    `   ${info.daemonCommand}`,
    '',
    '======================================================',
  ].join('\n');
}
