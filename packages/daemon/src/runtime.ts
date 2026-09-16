import { hostname as defaultHostname } from 'node:os';

export interface RuntimeMetadata {
  hostname: string;
  daemonVersion: string;
  agyVersion: string | null;
}

export interface RuntimeMetadataInput {
  hostname?: () => string;
  daemonVersion?: string;
  agyVersion?: string;
}

export function getRuntimeMetadata(input: RuntimeMetadataInput = {}): RuntimeMetadata {
  return {
    hostname: input.hostname?.() ?? defaultHostname(),
    daemonVersion: input.daemonVersion ?? '0.0.0',
    agyVersion: input.agyVersion ?? null,
  };
}

