export const ModelSupportInvestigationModal__tool_protocol_probe_summary = ({ mode, forcedTokenCount, generatedTokenCount, firstMismatchIndex, reason, parserMode, parserStrategy, parserToolCallCount, parserReason, roundTripMode, roundTripTokenCount, roundTripReason }: { mode: 'observed-exact' | 'observed-incomplete' | 'unavailable' | 'failed'; forcedTokenCount: number | undefined; generatedTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined; parserMode: 'recognized' | 'unrecognized' | 'unavailable' | 'failed' | 'not-run'; parserStrategy: string | undefined; parserToolCallCount: number | undefined; parserReason: string | undefined; roundTripMode: 'observed' | 'unavailable' | 'failed' | 'not-run'; roundTripTokenCount: number | undefined; roundTripReason: string | undefined }): string => {
  const parserSummary = (() => {
    switch (parserMode) {
    case 'recognized':
      return ` El parser Production ${parserStrategy ?? 'desconocido'} reconoció ${parserToolCallCount ?? 0} ${(parserToolCallCount ?? 0) === 1 ? 'llamada de herramienta' : 'llamadas de herramienta'}.`;
    case 'unrecognized':
      return ` El parser Production ${parserStrategy ?? 'desconocido'} se ejecutó, pero no reconoció ninguna llamada de herramienta.`;
    case 'unavailable':
      return ` La observación del parser Production ${parserStrategy ?? 'desconocido'} no estaba disponible: ${parserReason ?? 'motivo desconocido'}.`;
    case 'failed':
      return ` La observación del parser Production ${parserStrategy ?? 'desconocido'} falló: ${parserReason ?? 'fallo desconocido'}.`;
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
      return ` La salida del parser más el resultado fijo de la herramienta se volvió a renderizar en ${roundTripTokenCount ?? 0} ${(roundTripTokenCount ?? 0) === 1 ? 'token de continuación' : 'tokens de continuación'}; no se ejecutó la generación real de la continuación.`;
    case 'unavailable':
      return ` El recorrido de ida y vuelta del parser a la plantilla no estaba disponible: ${roundTripReason ?? 'motivo desconocido'}.`;
    case 'failed':
      return ` El recorrido de ida y vuelta del parser a la plantilla falló: ${roundTripReason ?? 'fallo desconocido'}.`;
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
    return `Prueba forzada del protocolo de herramientas: tokens derivados de la plantilla emitidos: ${generatedTokenCount ?? 0}.${parserSummary}${roundTripSummary}`;
  case 'observed-incomplete':
    return `Prueba forzada del protocolo de herramientas: tokens emitidos: ${generatedTokenCount ?? 0} de ${forcedTokenCount ?? 0}; primera divergencia o parada anticipada en ${firstMismatchIndex ?? 'el límite de longitud'}.${parserSummary}${roundTripSummary}`;
  case 'unavailable':
    return `Prueba forzada del protocolo de herramientas no disponible: ${reason ?? 'no había disponible ninguna secuencia segura derivada de la plantilla'}`;
  case 'failed':
    return `Prueba forzada del protocolo de herramientas falló: ${reason ?? 'fallo desconocido'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
