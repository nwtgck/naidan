export const ModelSupportInvestigationModal__persistence_roundtrip_summary = ({ status, exactModelVisibleMatch, serializedByteLength, firstMismatchIndex, errorName, errorMessage }: { status: 'observed' | 'failed', exactModelVisibleMatch: boolean | undefined, serializedByteLength: number | undefined, firstMismatchIndex: number | undefined, errorName: string | undefined, errorMessage: string | undefined }): string => {
  switch (status) {
  case 'observed':
    return `Contrato de serialización de persistencia: observado; ida y vuelta visible para el modelo=${exactModelVisibleMatch ? 'exacta' : `diferencia en ${firstMismatchIndex ?? 'límite'}`}; JSON=${serializedByteLength ?? 0} bytes; E/S de almacenamiento físico=no observada`;
  case 'failed':
    return `Contrato de serialización de persistencia: fallido; ${errorName ?? 'Error'}: ${errorMessage ?? 'no disponible'}; E/S de almacenamiento físico=no observada`;
  default: {
    const _ex: never = status;
    return _ex;
  }
  }
};
