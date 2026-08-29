export const ModelSupportInvestigationModal__tool_template_provenance_summary = ({ mode, suffixTokenCount, firstMismatchIndex, reason }: { mode: 'prefix' | 'difference' | 'unavailable'; suffixTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined }): string => {
  switch (mode) {
  case 'prefix':
    return `Proveniência do template de ferramentas: ${suffixTokenCount ?? 0} ${(suffixTokenCount ?? 0) === 1 ? 'token de sufixo' : 'tokens de sufixo'} da chamada de ferramenta do assistant ${(suffixTokenCount ?? 0) === 1 ? 'foi isolado' : 'foram isolados'} da saída resolvida do tokenizador.`;
  case 'difference':
    return `Proveniência do template de ferramentas: as sequências de tokens renderizadas diferem pela primeira vez em ${firstMismatchIndex ?? 'o limite de comprimento'}; nenhum sufixo foi inferido.`;
  case 'unavailable':
    return `Proveniência do template de ferramentas indisponível: ${reason ?? 'os casos de template necessários não foram observados'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
