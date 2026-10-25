export const GenerationSpeed__scope = ({ scope, live, nCalls }: { scope: 'current' | 'turn' | 'last', live: boolean, nCalls: number }): string  => {
  if (live) {
    return "测量中 · 当前生成";
  }
  switch (scope) {
  case 'turn': return "已完成 · 合并模型调用";
  case 'current': case 'last': return nCalls === 1 ? "生成完成" : "已完成 · 最后一次模型调用";
  default: {
    const exhaustive: never = scope;
    throw new Error(`Unhandled scope: ${exhaustive}`);
  }
  }
};
