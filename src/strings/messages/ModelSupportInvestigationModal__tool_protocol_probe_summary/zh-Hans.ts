export const ModelSupportInvestigationModal__tool_protocol_probe_summary = ({ mode, forcedTokenCount, generatedTokenCount, firstMismatchIndex, reason, parserMode, parserStrategy, parserToolCallCount, parserReason, roundTripMode, roundTripTokenCount, roundTripReason }: { mode: 'observed-exact' | 'observed-incomplete' | 'unavailable' | 'failed'; forcedTokenCount: number | undefined; generatedTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined; parserMode: 'recognized' | 'unrecognized' | 'unavailable' | 'failed' | 'not-run'; parserStrategy: string | undefined; parserToolCallCount: number | undefined; parserReason: string | undefined; roundTripMode: 'observed' | 'unavailable' | 'failed' | 'not-run'; roundTripTokenCount: number | undefined; roundTripReason: string | undefined }): string => {
  const parserSummary = (() => {
    switch (parserMode) {
    case 'recognized':
      return ` Production ${parserStrategy ?? '未知'} 解析器识别出 ${parserToolCallCount ?? 0} 个工具调用。`;
    case 'unrecognized':
      return ` Production ${parserStrategy ?? '未知'} 解析器已运行，但未识别出工具调用。`;
    case 'unavailable':
      return ` 无法观测 Production ${parserStrategy ?? '未知'} 解析器：${parserReason ?? '原因未知'}。`;
    case 'failed':
      return ` Production ${parserStrategy ?? '未知'} 解析器观测失败：${parserReason ?? '未知失败'}。`;
    case 'not-run':
      return '';
    default: {
      const _ex: never = parserMode;
      return _ex;
    }
    }
  })();
  const roundTripSummary = (() => {
    switch (roundTripMode) {
    case 'observed':
      return ` 解析器输出与固定工具结果重新渲染为 ${roundTripTokenCount ?? 0} 个续生成 token；未运行真实续生成。`;
    case 'unavailable':
      return ` 无法执行解析器到模板的往返处理：${roundTripReason ?? '原因未知'}。`;
    case 'failed':
      return ` 解析器到模板的往返处理失败：${roundTripReason ?? '未知失败'}。`;
    case 'not-run':
      return '';
    default: {
      const _ex: never = roundTripMode;
      return _ex;
    }
    }
  })();
  switch (mode) {
  case 'observed-exact':
    return `强制工具协议测试：已生成全部 ${generatedTokenCount ?? 0} 个由模板派生的 token。${parserSummary}${roundTripSummary}`;
  case 'observed-incomplete':
    return `强制工具协议测试：已生成 ${generatedTokenCount ?? 0} / ${forcedTokenCount ?? 0} 个 token；首次不一致或提前停止于 ${firstMismatchIndex ?? '长度边界'}。${parserSummary}${roundTripSummary}`;
  case 'unavailable':
    return `无法执行强制工具协议测试：${reason ?? '没有可用的安全模板派生序列'}`;
  case 'failed':
    return `强制工具协议测试失败：${reason ?? '未知失败'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
