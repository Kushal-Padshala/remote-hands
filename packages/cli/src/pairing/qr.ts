export function generatePairingUrl(
  webUrl: string,
  pairingCode: string,
  ownerSecret?: string | undefined,
): string {
  const base = webUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('code', pairingCode);
  if (ownerSecret) {
    params.set('secret', ownerSecret);
  }
  return `${base}/pair?${params.toString()}`;
}
