// Production authority for the Naidan-local transition-progress companion.
export const NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS = {
  crypto: {
    aead: 'AES-256-GCM',
    aadDomain: 'Naidan/HizoFS-integration/v1/transition-progress-aad',
    keyDomain: 'Naidan/HizoFS-integration/v1/transition-progress-key',
    nonceBytes: 12,
    tagBytes: 16,
  },
  format: 'naidan-transition-progress',
  formatVersion: 1,
  limits: {
    authorityIdentityCharacters: 256,
    canonicalJsonDepth: 4,
    companionJsonBytes: 8 * 1024 * 1024,
    plaintextJsonBytes: 6 * 1024 * 1024,
    portableProgressBytes: 3 * 1024 * 1024,
    portableProgressDirectoryFrames: 65_536,
    portableProgressJsonDepth: 16,
    portableProgressPathComponents: 1_024,
    providerCheckpointBytes: 3 * 1024 * 1024,
  },
  plainTargetCheckpoint: {
    format: 'naidan-opfs-plain-target',
    formatVersion: 1,
    maximumBytes: 256,
    maximumDepth: 2,
  },
  portableProgressCodec: 'naidan-transition-runtime-progress-v1',
  providerCheckpointCodecs: {
    hizofs: 'hizofs-streaming-namespace-import-v1',
    nativePlain: 'naidan-opfs-plain-target-v1',
  },
  providerKind: 'hizofs',
  sequenceMinimum: 1,
  storage: {
    directoryName: 'transition-progress',
    files: ['state-0.json', 'state-1.json'],
  },
} as const;

export type NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS = typeof NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS;

export const TEST_ONLY = {
};
