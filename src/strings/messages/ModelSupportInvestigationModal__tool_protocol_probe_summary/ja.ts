export const ModelSupportInvestigationModal__tool_protocol_probe_summary = ({ mode, forcedTokenCount, generatedTokenCount, firstMismatchIndex, reason, parserMode, parserStrategy, parserToolCallCount, parserReason, roundTripMode, roundTripTokenCount, roundTripReason }: { mode: 'observed-exact' | 'observed-incomplete' | 'unavailable' | 'failed'; forcedTokenCount: number | undefined; generatedTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined; parserMode: 'recognized' | 'unrecognized' | 'unavailable' | 'failed' | 'not-run'; parserStrategy: string | undefined; parserToolCallCount: number | undefined; parserReason: string | undefined; roundTripMode: 'observed' | 'unavailable' | 'failed' | 'not-run'; roundTripTokenCount: number | undefined; roundTripReason: string | undefined }): string => {
  const parserSummary = (() => {
    switch (parserMode) {
    case 'recognized':
      return ` Production ${parserStrategy ?? 'unknown'} parserが${parserToolCallCount ?? 0}件のtool callを認識しました。`;
    case 'unrecognized':
      return ` Production ${parserStrategy ?? 'unknown'} parserを実行しましたが、tool callを認識しませんでした。`;
    case 'unavailable':
      return ` Production ${parserStrategy ?? 'unknown'} parser観測を実行できません：${parserReason ?? '原因不明'}。`;
    case 'failed':
      return ` Production ${parserStrategy ?? 'unknown'} parser観測に失敗しました：${parserReason ?? '原因不明'}。`;
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
      return ` Parser出力と固定tool resultを${roundTripTokenCount ?? 0} continuation tokenへ再renderしました。実モデルの継続生成は未実行です。`;
    case 'unavailable':
      return ` Parser→template roundtripを実行できません：${roundTripReason ?? '原因不明'}。`;
    case 'failed':
      return ` Parser→template roundtripに失敗しました：${roundTripReason ?? '原因不明'}。`;
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
    return `強制ツールprotocol probe：template由来の${generatedTokenCount ?? 0} tokenをすべて生成しました。${parserSummary}${roundTripSummary}`;
  case 'observed-incomplete':
    return `強制ツールprotocol probe：${forcedTokenCount ?? 0} token中${generatedTokenCount ?? 0} tokenを生成し、${firstMismatchIndex ?? '長さ境界'}で最初の不一致または早期終了を観測しました。${parserSummary}${roundTripSummary}`;
  case 'unavailable':
    return `強制ツールprotocol probeを実行できません：${reason ?? '安全なtemplate由来sequenceがありません'}`;
  case 'failed':
    return `強制ツールprotocol probeに失敗しました：${reason ?? '原因不明'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
