export function generatePairingUrl(
  webUrl: string,
  pairingCode: string,
  ownerSecret?: string | undefined,
  apiUrl?: string | undefined,
): string {
  const base = webUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('code', pairingCode);
  if (ownerSecret) {
    params.set('secret', ownerSecret);
  }
  if (apiUrl) {
    params.set('api', apiUrl);
  }
  return `${base}/pair?${params.toString()}`;
}
