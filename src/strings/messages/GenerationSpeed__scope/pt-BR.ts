export const GenerationSpeed__scope = ({ scope, live, nCalls }: { scope: 'current' | 'turn' | 'last', live: boolean, nCalls: number }): string  => {
  if (live) {
    return "Medindo · Geração atual";
  }
  switch (scope) {
  case 'turn': return "Concluído · Chamadas ao modelo combinadas";
  case 'current': case 'last': return nCalls === 1 ? "Geração concluída" : "Concluído · Última chamada ao modelo";
  default: {
    const exhaustive: never = scope;
    throw new Error(`Unhandled scope: ${exhaustive}`);
  }
  }
};
