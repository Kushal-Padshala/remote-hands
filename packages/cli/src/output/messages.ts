import { renderPairingTui } from './ui.js';

export interface PairingSummaryInfo {
  webUrl: string;
  pairingUrl: string;
  pairingCode: string;
  daemonCommand: string;
}

export async function formatPairingSummary(info: PairingSummaryInfo): Promise<string> {
  return await renderPairingTui(info);
}
