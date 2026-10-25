export const GenerationSpeed__scope = ({ scope, live, nCalls }: { scope: 'current' | 'turn' | 'last', live: boolean, nCalls: number }): string  => {
  if (live) {
    return "計測中・現在の生成";
  }
  switch (scope) {
  case 'turn': return "生成完了・一連のモデル生成";
  case 'current': case 'last': return nCalls === 1 ? "生成完了" : "生成完了・最後のモデル生成";
  default: {
    const exhaustive: never = scope;
    throw new Error(`Unhandled scope: ${exhaustive}`);
  }
  }
};
