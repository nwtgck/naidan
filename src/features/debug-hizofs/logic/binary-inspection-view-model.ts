export type HizoFSBinarySliceViewModel = Readonly<{
  bytes: Uint8Array;
  offset: number;
  regionByteLength: number;
  truncatedAfter: boolean;
}>;

export type HizoFSDecodedBinaryFieldViewModel = Readonly<{
  byteLength: number;
  encoding: "ascii" | "bytes" | "uint8" | "uint16_be" | "uint32_be" | "uint64_be";
  interpretation: string;
  name: string;
  offset: number;
  rawBytes: Uint8Array;
}>;

export type HizoFSBinaryRecordInspectionViewModel = Readonly<{
  decryptedRecord: Readonly<{
    binaryPayload: HizoFSBinarySliceViewModel;
    bytes: HizoFSBinarySliceViewModel;
    headerFields: readonly HizoFSDecodedBinaryFieldViewModel[];
    metadataJson: Readonly<{
      bytes: HizoFSBinarySliceViewModel;
      utf8Text: string | undefined;
    }>;
  }>;
  persistedObject: Readonly<{
    bytes: HizoFSBinarySliceViewModel;
    ciphertextByteLength: number;
    ciphertextOffset: number;
    headerFields: readonly HizoFSDecodedBinaryFieldViewModel[];
  }>;
}>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
