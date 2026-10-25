export const GenerationSpeed__scope = ({ scope, live, nCalls }: { scope: 'current' | 'turn' | 'last' | 'last_sample', live: boolean, nCalls: number }): string  => {
  if (live) {
    return "Messung läuft · Aktuelle Generierung";
  }
  switch (scope) {
  case 'last_sample': return "Abgeschlossen · Letzter Messwert";
  case 'turn': return "Abgeschlossen · Zusammengefasste Modellaufrufe";
  case 'current': case 'last': return nCalls === 1 ? "Generierung abgeschlossen" : "Abgeschlossen · Letzter Modellaufruf";
  default: {
    const exhaustive: never = scope;
    throw new Error(`Unhandled scope: ${exhaustive}`);
  }
  }
};
