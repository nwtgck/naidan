export const ModelSupportInvestigationModal__persistence_roundtrip_summary = ({ status, exactModelVisibleMatch, serializedByteLength, firstMismatchIndex, errorName, errorMessage }: { status: 'observed' | 'failed', exactModelVisibleMatch: boolean | undefined, serializedByteLength: number | undefined, firstMismatchIndex: number | undefined, errorName: string | undefined, errorMessage: string | undefined }): string => {
  switch (status) {
  case 'observed':
    return `Persistence serialization contract: observed; model-visible round trip=${exactModelVisibleMatch ? 'exact' : `mismatch at ${firstMismatchIndex ?? 'boundary'}`}; JSON=${serializedByteLength ?? 0} bytes; physical storage I/O=not observed`;
  case 'failed':
    return `Persistence serialization contract: failed; ${errorName ?? 'Error'}: ${errorMessage ?? 'unavailable'}; physical storage I/O=not observed`;
  default: {
    const _ex: never = status;
    return _ex;
  }
  }
};
