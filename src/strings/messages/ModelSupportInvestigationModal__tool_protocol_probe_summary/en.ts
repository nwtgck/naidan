export const ModelSupportInvestigationModal__tool_protocol_probe_summary = ({ mode, forcedTokenCount, generatedTokenCount, firstMismatchIndex, reason, parserMode, parserStrategy, parserToolCallCount, parserReason, roundTripMode, roundTripTokenCount, roundTripReason }: { mode: 'observed-exact' | 'observed-incomplete' | 'unavailable' | 'failed'; forcedTokenCount: number | undefined; generatedTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined; parserMode: 'recognized' | 'unrecognized' | 'unavailable' | 'failed' | 'not-run'; parserStrategy: string | undefined; parserToolCallCount: number | undefined; parserReason: string | undefined; roundTripMode: 'observed' | 'unavailable' | 'failed' | 'not-run'; roundTripTokenCount: number | undefined; roundTripReason: string | undefined }): string => {
  const parserSummary = (() => {
    switch (parserMode) {
    case 'recognized':
      return ` Production ${parserStrategy ?? 'unknown'} parser recognized ${parserToolCallCount ?? 0} tool call(s).`;
    case 'unrecognized':
      return ` Production ${parserStrategy ?? 'unknown'} parser ran but recognized no tool call.`;
    case 'unavailable':
      return ` Production ${parserStrategy ?? 'unknown'} parser observation was unavailable: ${parserReason ?? 'unknown reason'}.`;
    case 'failed':
      return ` Production ${parserStrategy ?? 'unknown'} parser observation failed: ${parserReason ?? 'unknown failure'}.`;
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
      return ` Parser output plus the fixed tool result re-rendered into ${roundTripTokenCount ?? 0} continuation token(s); real continuation generation was not run.`;
    case 'unavailable':
      return ` Parser-to-template roundtrip was unavailable: ${roundTripReason ?? 'unknown reason'}.`;
    case 'failed':
      return ` Parser-to-template roundtrip failed: ${roundTripReason ?? 'unknown failure'}.`;
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
    return `Forced tool protocol probe: all ${generatedTokenCount ?? 0} template-derived tokens were emitted.${parserSummary}${roundTripSummary}`;
  case 'observed-incomplete':
    return `Forced tool protocol probe: ${generatedTokenCount ?? 0} of ${forcedTokenCount ?? 0} tokens were emitted; first mismatch or early stop at ${firstMismatchIndex ?? 'the length boundary'}.${parserSummary}${roundTripSummary}`;
  case 'unavailable':
    return `Forced tool protocol probe unavailable: ${reason ?? 'no safe template-derived sequence was available'}`;
  case 'failed':
    return `Forced tool protocol probe failed: ${reason ?? 'unknown failure'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
