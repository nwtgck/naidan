export const GenerationSpeed__scope = ({ scope, live, nCalls }: { scope: 'current' | 'turn' | 'last', live: boolean, nCalls: number }): string  => {
  if (live) {
    return "Midiendo · Generación actual";
  }
  switch (scope) {
  case 'turn': return "Completado · Llamadas al modelo combinadas";
  case 'current': case 'last': return nCalls === 1 ? "Generación completada" : "Completado · Última llamada al modelo";
  default: {
    const exhaustive: never = scope;
    throw new Error(`Unhandled scope: ${exhaustive}`);
  }
  }
};
