export const ModelSupportInvestigationSession__fresh_metadata_preparation_status = ({ status }: { status: 'running' | 'prepared' | 'failed' | 'timeout' | 'interrupted' | 'not-run' | 'not-recorded' }): string => {
  switch (status) {
  case 'running': return "Preparação de metadados obtidos novamente: em andamento";
  case 'prepared': return "Preparação de metadados obtidos novamente: concluída";
  case 'failed': return "Preparação de metadados obtidos novamente: falhou";
  case 'timeout': return "Preparação de metadados obtidos novamente: tempo esgotado";
  case 'interrupted': return "Preparação de metadados obtidos novamente: interrompida";
  case 'not-run': return "Preparação de metadados obtidos novamente: não executada";
  case 'not-recorded': return "Preparação de metadados obtidos novamente: não registrada";
  default: {
    const exhaustive: never = status;
    throw new Error(`Unhandled fresh metadata status: ${exhaustive}`);
  }
  }
};
