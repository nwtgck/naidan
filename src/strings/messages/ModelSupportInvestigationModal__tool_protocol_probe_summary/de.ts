export const ModelSupportInvestigationModal__tool_protocol_probe_summary = ({ mode, forcedTokenCount, generatedTokenCount, firstMismatchIndex, reason, parserMode, parserStrategy, parserToolCallCount, parserReason, roundTripMode, roundTripTokenCount, roundTripReason }: { mode: 'observed-exact' | 'observed-incomplete' | 'unavailable' | 'failed'; forcedTokenCount: number | undefined; generatedTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined; parserMode: 'recognized' | 'unrecognized' | 'unavailable' | 'failed' | 'not-run'; parserStrategy: string | undefined; parserToolCallCount: number | undefined; parserReason: string | undefined; roundTripMode: 'observed' | 'unavailable' | 'failed' | 'not-run'; roundTripTokenCount: number | undefined; roundTripReason: string | undefined }): string => {
  const parserSummary = (() => {
    switch (parserMode) {
    case 'recognized':
      return ` Production ${parserStrategy ?? 'unbekannt'} Parser erkannte ${parserToolCallCount ?? 0} ${(parserToolCallCount ?? 0) === 1 ? 'Tool-Aufruf' : 'Tool-Aufrufe'}.`;
    case 'unrecognized':
      return ` Production ${parserStrategy ?? 'unbekannt'} Parser wurde ausgeführt, erkannte aber keinen Tool-Aufruf.`;
    case 'unavailable':
      return ` Production ${parserStrategy ?? 'unbekannt'} Parser-Beobachtung war nicht verfügbar: ${parserReason ?? 'unbekannter Grund'}.`;
    case 'failed':
      return ` Production ${parserStrategy ?? 'unbekannt'} Parser-Beobachtung ist fehlgeschlagen: ${parserReason ?? 'unbekannter Fehler'}.`;
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
      return ` Parser-Ausgabe plus festes Tool-Ergebnis wurden erneut gerendert zu ${roundTripTokenCount ?? 0} ${(roundTripTokenCount ?? 0) === 1 ? 'Fortsetzungs-Token' : 'Fortsetzungs-Tokens'}; die echte Fortsetzungsgenerierung wurde nicht ausgeführt.`;
    case 'unavailable':
      return ` Parser-zu-Template-Roundtrip war nicht verfügbar: ${roundTripReason ?? 'unbekannter Grund'}.`;
    case 'failed':
      return ` Parser-zu-Template-Roundtrip ist fehlgeschlagen: ${roundTripReason ?? 'unbekannter Fehler'}.`;
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
    return `Erzwungener Tool-Protokoll-Test: Vom Template abgeleitete Tokens ausgegeben: ${generatedTokenCount ?? 0}.${parserSummary}${roundTripSummary}`;
  case 'observed-incomplete':
    return `Erzwungener Tool-Protokoll-Test: Ausgegebene Tokens: ${generatedTokenCount ?? 0} von ${forcedTokenCount ?? 0}; erste Abweichung oder vorzeitiger Stopp bei ${firstMismatchIndex ?? 'der Längengrenze'}.${parserSummary}${roundTripSummary}`;
  case 'unavailable':
    return `Erzwungener Tool-Protokoll-Test nicht verfügbar: ${reason ?? 'keine sichere vom Template abgeleitete Sequenz war verfügbar'}`;
  case 'failed':
    return `Erzwungener Tool-Protokoll-Test fehlgeschlagen: ${reason ?? 'unbekannter Fehler'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
