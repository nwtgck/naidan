export const GenerationSpeed__scope = ({ scope, live, nCalls }: { scope: 'current' | 'turn' | 'last' | 'last_sample', live: boolean, nCalls: number }): string  => {
  if (live) {
    return "Medindo · Geração atual";
  }
  switch (scope) {
  case 'last_sample': return "Concluído · Última medição";
  case 'turn': return "Concluído · Chamadas ao modelo combinadas";
  case 'current': case 'last': return nCalls === 1 ? "Geração concluída" : "Concluído · Última chamada ao modelo";
  default: {
    const exhaustive: never = scope;
    throw new Error(`Unhandled scope: ${exhaustive}`);
  }
  }
};
