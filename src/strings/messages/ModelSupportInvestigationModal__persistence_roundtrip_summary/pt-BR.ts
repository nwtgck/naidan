export const ModelSupportInvestigationModal__persistence_roundtrip_summary = ({ status, exactModelVisibleMatch, serializedByteLength, firstMismatchIndex, errorName, errorMessage }: { status: 'observed' | 'failed', exactModelVisibleMatch: boolean | undefined, serializedByteLength: number | undefined, firstMismatchIndex: number | undefined, errorName: string | undefined, errorMessage: string | undefined }): string => {
  switch (status) {
  case 'observed':
    return `Contrato de serialização da persistência: observado; ida e volta visível ao modelo=${exactModelVisibleMatch ? 'exata' : `divergência em ${firstMismatchIndex ?? 'limite'}`}; JSON=${serializedByteLength ?? 0} bytes; E/S de armazenamento físico=não observada`;
  case 'failed':
    return `Contrato de serialização da persistência: falhou; ${errorName ?? 'Error'}: ${errorMessage ?? 'indisponível'}; E/S de armazenamento físico=não observada`;
  default: {
    const _ex: never = status;
    return _ex;
  }
  }
};
