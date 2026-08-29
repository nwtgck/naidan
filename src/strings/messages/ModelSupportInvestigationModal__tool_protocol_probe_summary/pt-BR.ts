export const ModelSupportInvestigationModal__tool_protocol_probe_summary = ({ mode, forcedTokenCount, generatedTokenCount, firstMismatchIndex, reason, parserMode, parserStrategy, parserToolCallCount, parserReason, roundTripMode, roundTripTokenCount, roundTripReason }: { mode: 'observed-exact' | 'observed-incomplete' | 'unavailable' | 'failed'; forcedTokenCount: number | undefined; generatedTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined; parserMode: 'recognized' | 'unrecognized' | 'unavailable' | 'failed' | 'not-run'; parserStrategy: string | undefined; parserToolCallCount: number | undefined; parserReason: string | undefined; roundTripMode: 'observed' | 'unavailable' | 'failed' | 'not-run'; roundTripTokenCount: number | undefined; roundTripReason: string | undefined }): string => {
  const parserSummary = (() => {
    switch (parserMode) {
    case 'recognized':
      return ` O parser Production ${parserStrategy ?? 'desconhecido'} reconheceu ${parserToolCallCount ?? 0} ${(parserToolCallCount ?? 0) === 1 ? 'chamada de ferramenta' : 'chamadas de ferramenta'}.`;
    case 'unrecognized':
      return ` O parser Production ${parserStrategy ?? 'desconhecido'} foi executado, mas não reconheceu nenhuma chamada de ferramenta.`;
    case 'unavailable':
      return ` A observação do parser Production ${parserStrategy ?? 'desconhecido'} não estava disponível: ${parserReason ?? 'motivo desconhecido'}.`;
    case 'failed':
      return ` A observação do parser Production ${parserStrategy ?? 'desconhecido'} falhou: ${parserReason ?? 'falha desconhecida'}.`;
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
      return ` A saída do parser, junto com o resultado fixo da ferramenta, foi renderizada novamente em ${roundTripTokenCount ?? 0} ${(roundTripTokenCount ?? 0) === 1 ? 'token de continuação' : 'tokens de continuação'}; a geração real da continuação não foi executada.`;
    case 'unavailable':
      return ` O roundtrip do parser para o template estava indisponível: ${roundTripReason ?? 'motivo desconhecido'}.`;
    case 'failed':
      return ` O roundtrip do parser para o template falhou: ${roundTripReason ?? 'falha desconhecida'}.`;
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
    return `Teste forçado do protocolo de ferramentas: tokens derivados do template emitidos: ${generatedTokenCount ?? 0}.${parserSummary}${roundTripSummary}`;
  case 'observed-incomplete':
    return `Teste forçado do protocolo de ferramentas: tokens emitidos: ${generatedTokenCount ?? 0} de ${forcedTokenCount ?? 0}; primeira divergência ou parada antecipada em ${firstMismatchIndex ?? 'o limite de comprimento'}.${parserSummary}${roundTripSummary}`;
  case 'unavailable':
    return `Teste forçado do protocolo de ferramentas indisponível: ${reason ?? 'nenhuma sequência segura derivada do template estava disponível'}`;
  case 'failed':
    return `Teste forçado do protocolo de ferramentas falhou: ${reason ?? 'falha desconhecida'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
