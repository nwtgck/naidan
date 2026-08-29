export const ModelSupportInvestigationModal__tool_protocol_probe_summary = ({ mode, forcedTokenCount, generatedTokenCount, firstMismatchIndex, reason, parserMode, parserStrategy, parserToolCallCount, parserReason, roundTripMode, roundTripTokenCount, roundTripReason }: { mode: 'observed-exact' | 'observed-incomplete' | 'unavailable' | 'failed'; forcedTokenCount: number | undefined; generatedTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined; parserMode: 'recognized' | 'unrecognized' | 'unavailable' | 'failed' | 'not-run'; parserStrategy: string | undefined; parserToolCallCount: number | undefined; parserReason: string | undefined; roundTripMode: 'observed' | 'unavailable' | 'failed' | 'not-run'; roundTripTokenCount: number | undefined; roundTripReason: string | undefined }): string => {
  const parserSummary = (() => {
    switch (parserMode) {
    case 'recognized':
      return ` Production ${parserStrategy ?? '알 수 없음'} 파서가 도구 호출 ${parserToolCallCount ?? 0}개를 인식했습니다.`;
    case 'unrecognized':
      return ` Production ${parserStrategy ?? '알 수 없음'} 파서를 실행했지만 도구 호출을 인식하지 못했습니다.`;
    case 'unavailable':
      return ` Production ${parserStrategy ?? '알 수 없음'} 파서 관측을 사용할 수 없음: ${parserReason ?? '알 수 없는 이유'}.`;
    case 'failed':
      return ` Production ${parserStrategy ?? '알 수 없음'} 파서 관측 실패: ${parserReason ?? '알 수 없는 실패'}.`;
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
      return ` 파서 출력과 고정 도구 결과를 다시 렌더링하여 연속 생성 토큰 ${roundTripTokenCount ?? 0}개를 만들었습니다. 실제 연속 생성은 실행하지 않았습니다.`;
    case 'unavailable':
      return ` 파서에서 템플릿까지의 왕복 처리를 사용할 수 없음: ${roundTripReason ?? '알 수 없는 이유'}.`;
    case 'failed':
      return ` 파서에서 템플릿까지의 왕복 처리 실패: ${roundTripReason ?? '알 수 없는 실패'}.`;
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
    return `강제 도구 프로토콜 테스트: 템플릿에서 파생된 토큰 ${generatedTokenCount ?? 0}개가 모두 생성되었습니다.${parserSummary}${roundTripSummary}`;
  case 'observed-incomplete':
    return `강제 도구 프로토콜 테스트: ${generatedTokenCount ?? 0} / ${forcedTokenCount ?? 0}개 토큰 생성; 첫 불일치 또는 조기 중단 위치: ${firstMismatchIndex ?? '길이 경계'}.${parserSummary}${roundTripSummary}`;
  case 'unavailable':
    return `강제 도구 프로토콜 테스트를 사용할 수 없음: ${reason ?? '안전한 템플릿 파생 시퀀스를 사용할 수 없음'}`;
  case 'failed':
    return `강제 도구 프로토콜 테스트 실패: ${reason ?? '알 수 없는 실패'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
