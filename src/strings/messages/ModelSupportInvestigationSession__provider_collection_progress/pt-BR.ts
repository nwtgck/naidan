export const ModelSupportInvestigationSession__provider_collection_progress = ({ phase, settled, total, active }: { phase: 'not-started' | 'loading' | 'running' | 'collecting' | 'sealing' | 'cleanup' | 'seal-release' | 'finished'; settled: number; total: number; active: string | undefined }): string => {
  const labels = {"not-started":"Preparando","loading":"Carregando o modelo local","running":"Executando solicitações fixas","collecting":"Coletando registros nativos","sealing":"Preparando arquivos de evidência","cleanup":"Aguardando a limpeza do Worker","seal-release":"Aguardando a liberação dos registros","finished":"Coleta encerrada"};
  return `${labels[phase]} · ${settled}/${total} solicitações encerradas${active === undefined ? "" : ` · ${active}`}`;
};
