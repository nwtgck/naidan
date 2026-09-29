export const ModelSupportInvestigationSession__fresh_metadata_preparation_status = ({ status }: { status: 'running' | 'prepared' | 'failed' | 'timeout' | 'interrupted' | 'not-run' | 'not-recorded' }): string => {
  switch (status) {
  case 'running': return "Preparación de metadatos mediante una nueva descarga: en curso";
  case 'prepared': return "Preparación de metadatos mediante una nueva descarga: correcta";
  case 'failed': return "Preparación de metadatos mediante una nueva descarga: fallida";
  case 'timeout': return "Preparación de metadatos mediante una nueva descarga: tiempo agotado";
  case 'interrupted': return "Preparación de metadatos mediante una nueva descarga: interrumpida";
  case 'not-run': return "Preparación de metadatos mediante una nueva descarga: no ejecutada";
  case 'not-recorded': return "Preparación de metadatos mediante una nueva descarga: no registrada";
  default: {
    const exhaustive: never = status;
    throw new Error(`Unhandled fresh metadata status: ${exhaustive}`);
  }
  }
};
