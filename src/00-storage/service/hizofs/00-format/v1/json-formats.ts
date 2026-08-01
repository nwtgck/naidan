// Production authority for canonical HizoFS V1 JSON field order.
export const HIZOFS_V1_JSON_FORMATS = {
  "unlockEnvelope": {
    "format": "hizofs-unlock",
    "fieldOrder": [
      "format",
      "formatVersion",
      "copy",
      "sequence",
      "fileSystemId",
      "credentialSlots",
      "authenticatorNonce",
      "authenticatorTag"
    ]
  },
  "credentialSlot": {
    "fieldOrder": [
      "type",
      "slotId",
      "method",
      "methodVersion",
      "methodParameters",
      "wrappedFileSystemRootKey"
    ]
  }
} as const;

export type HIZOFS_V1_JSON_FORMATS = typeof HIZOFS_V1_JSON_FORMATS;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
