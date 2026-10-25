export const GenerationSpeed__scope = ({ scope, live, nCalls }: { scope: 'current' | 'turn' | 'last' | 'last_sample', live: boolean, nCalls: number }): string  => {
  if (live) {
    return "측정 중 · 현재 생성";
  }
  switch (scope) {
  case 'last_sample': return "완료 · 마지막 측정값";
  case 'turn': return "완료 · 모델 호출 합산";
  case 'current': case 'last': return nCalls === 1 ? "생성 완료" : "완료 · 마지막 모델 호출";
  default: {
    const exhaustive: never = scope;
    throw new Error(`Unhandled scope: ${exhaustive}`);
  }
  }
};
