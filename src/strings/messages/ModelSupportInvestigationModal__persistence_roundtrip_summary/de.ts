export const ModelSupportInvestigationModal__persistence_roundtrip_summary = ({ status, exactModelVisibleMatch, serializedByteLength, firstMismatchIndex, errorName, errorMessage }: { status: 'observed' | 'failed', exactModelVisibleMatch: boolean | undefined, serializedByteLength: number | undefined, firstMismatchIndex: number | undefined, errorName: string | undefined, errorMessage: string | undefined }): string => {
  switch (status) {
  case 'observed':
    return `Persistenz-Serialisierungsvertrag: beobachtet; modell-sichtbarer Roundtrip=${exactModelVisibleMatch ? 'exakt' : `Abweichung bei ${firstMismatchIndex ?? 'Grenze'}`}; JSON=${serializedByteLength ?? 0} Byte; physischer Speicher-I/O=nicht beobachtet`;
  case 'failed':
    return `Persistenz-Serialisierungsvertrag: fehlgeschlagen; ${errorName ?? 'Error'}: ${errorMessage ?? 'nicht verfügbar'}; physischer Speicher-I/O=nicht beobachtet`;
  default: {
    const _ex: never = status;
    return _ex;
  }
  }
};
