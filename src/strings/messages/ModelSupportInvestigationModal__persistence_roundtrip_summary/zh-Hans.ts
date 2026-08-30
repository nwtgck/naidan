export const ModelSupportInvestigationModal__persistence_roundtrip_summary = ({ status, exactModelVisibleMatch, serializedByteLength, firstMismatchIndex, errorName, errorMessage }: { status: 'observed' | 'failed', exactModelVisibleMatch: boolean | undefined, serializedByteLength: number | undefined, firstMismatchIndex: number | undefined, errorName: string | undefined, errorMessage: string | undefined }): string => {
  switch (status) {
  case 'observed':
    return `持久化序列化契约：已观测；模型可见往返=${exactModelVisibleMatch ? '完全一致' : `在 ${firstMismatchIndex ?? '边界'} 处不一致`}；JSON=${serializedByteLength ?? 0} 字节；物理存储 I/O=未观测`;
  case 'failed':
    return `持久化序列化契约：失败；${errorName ?? 'Error'}: ${errorMessage ?? '不可用'}；物理存储 I/O=未观测`;
  default: {
    const _ex: never = status;
    return _ex;
  }
  }
};
