export const ModelSupportInvestigationModal__persistence_roundtrip_summary = ({ status, exactModelVisibleMatch, serializedByteLength, firstMismatchIndex, errorName, errorMessage }: { status: 'observed' | 'failed', exactModelVisibleMatch: boolean | undefined, serializedByteLength: number | undefined, firstMismatchIndex: number | undefined, errorName: string | undefined, errorMessage: string | undefined }): string => {
  switch (status) {
  case 'observed':
    return `영속성 직렬화 계약: 관측됨; 모델에 보이는 왕복=${exactModelVisibleMatch ? '완전 일치' : `${firstMismatchIndex ?? '경계'}에서 불일치`}; JSON=${serializedByteLength ?? 0}바이트; 실제 스토리지 I/O=관측 안 됨`;
  case 'failed':
    return `영속성 직렬화 계약: 실패; ${errorName ?? 'Error'}: ${errorMessage ?? '사용 불가'}; 실제 스토리지 I/O=관측 안 됨`;
  default: {
    const _ex: never = status;
    return _ex;
  }
  }
};
