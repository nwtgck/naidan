export const GenerationSpeed__scope = ({ scope, live, nCalls }: { scope: 'current' | 'turn' | 'last' | 'last_sample', live: boolean, nCalls: number }): string  => {
  if (live) {
    return "Measuring · Current generation";
  }
  switch (scope) {
  case 'last_sample': return "Complete · Last measured sample";
  case 'turn': return "Complete · Combined model calls";
  case 'current': case 'last': return nCalls === 1 ? "Complete · Generation" : "Complete · Last model call";
  default: {
    const exhaustive: never = scope;
    throw new Error(`Unhandled scope: ${exhaustive}`);
  }
  }
};
