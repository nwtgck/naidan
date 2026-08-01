// Canonical field-order authority for the Naidan-local transition-progress companion.
export const NAIDAN_TRANSITION_PROGRESS_JSON_FORMATS = {
  envelope: {
    fieldOrder: [
      'format',
      'formatVersion',
      'copy',
      'sequence',
      'operationId',
      'providerKind',
      'authenticationFileSystemId',
      'nonce',
      'ciphertext',
    ],
  },
  plaintext: {
    fieldOrder: [
      'sourceAuthorityIdentity',
      'sourceEndpoint',
      'targetAuthorityIdentity',
      'targetEndpoint',
      'journalGeneration',
      'portableProgressCodec',
      'portableProgressBytes',
      'providerCheckpointCodec',
      'providerCheckpointState',
      'providerCheckpointBytes',
    ],
  },
  unsignedEnvelope: {
    fieldOrder: [
      'format',
      'formatVersion',
      'copy',
      'sequence',
      'operationId',
      'providerKind',
      'authenticationFileSystemId',
      'nonce',
    ],
  },
} as const;

export type NAIDAN_TRANSITION_PROGRESS_JSON_FORMATS = typeof NAIDAN_TRANSITION_PROGRESS_JSON_FORMATS;

export const TEST_ONLY = {
};
