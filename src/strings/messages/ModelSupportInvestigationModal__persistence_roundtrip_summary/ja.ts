export const ModelSupportInvestigationModal__persistence_roundtrip_summary = ({ status, exactModelVisibleMatch, serializedByteLength, firstMismatchIndex, errorName, errorMessage }: { status: 'observed' | 'failed', exactModelVisibleMatch: boolean | undefined, serializedByteLength: number | undefined, firstMismatchIndex: number | undefined, errorName: string | undefined, errorMessage: string | undefined }): string => {
  switch (status) {
  case 'observed':
    return `永続化シリアライズ契約: 観測済み; モデル可視round trip=${exactModelVisibleMatch ? '完全一致' : `${firstMismatchIndex ?? '境界'}で不一致`}; JSON=${serializedByteLength ?? 0} bytes; 実storage I/O=未観測`;
  case 'failed':
    return `永続化シリアライズ契約: 失敗; ${errorName ?? 'Error'}: ${errorMessage ?? '取得不可'}; 実storage I/O=未観測`;
  default: {
    const _ex: never = status;
    return _ex;
  }
  }
};
