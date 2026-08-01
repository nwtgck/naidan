// Production authority for canonical Naidan Persistence Control JSON field order.
export const NAIDAN_PERSISTENCE_CONTROL_JSON_FORMATS = {
  "persistenceControl": {
    "format": "naidan-persistence-control",
    "fieldOrder": [
      "format",
      "formatVersion",
      "copy",
      "sequence",
      "mode",
      "retiredFileSystemIds",
      "protection"
    ]
  },
  "persistenceEndpointPlain": {
    "fieldOrder": [
      "type"
    ]
  },
  "persistenceEndpointHizoFS": {
    "fieldOrder": [
      "type",
      "fileSystemId"
    ]
  },
  "transitionPhase": {
    "fieldOrder": [
      "type",
      "source",
      "target"
    ]
  },
  "persistenceModePlain": {
    "fieldOrder": [
      "type"
    ]
  },
  "persistenceModeHizoFS": {
    "fieldOrder": [
      "type",
      "activeFileSystemId"
    ]
  },
  "persistenceModeTransitioning": {
    "fieldOrder": [
      "type",
      "operationId",
      "operation",
      "phase"
    ]
  },
  "plainControlProtection": {
    "fieldOrder": [
      "type",
      "digest"
    ]
  },
  "hizoFSControlProtection": {
    "fieldOrder": [
      "type",
      "authenticationFileSystemId",
      "nonce",
      "authenticatorTag"
    ]
  }
} as const;

export type NAIDAN_PERSISTENCE_CONTROL_JSON_FORMATS = typeof NAIDAN_PERSISTENCE_CONTROL_JSON_FORMATS;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
