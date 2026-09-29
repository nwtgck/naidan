export const ModelSupportInvestigationSession__fresh_metadata_preparation_status = ({ status }: { status: 'running' | 'prepared' | 'failed' | 'timeout' | 'interrupted' | 'not-run' | 'not-recorded' }): string => {
  switch (status) {
  case 'running': return "Metadatenvorbereitung durch neuen Abruf: läuft";
  case 'prepared': return "Metadatenvorbereitung durch neuen Abruf: erfolgreich";
  case 'failed': return "Metadatenvorbereitung durch neuen Abruf: fehlgeschlagen";
  case 'timeout': return "Metadatenvorbereitung durch neuen Abruf: Zeitlimit überschritten";
  case 'interrupted': return "Metadatenvorbereitung durch neuen Abruf: unterbrochen";
  case 'not-run': return "Metadatenvorbereitung durch neuen Abruf: nicht ausgeführt";
  case 'not-recorded': return "Metadatenvorbereitung durch neuen Abruf: nicht aufgezeichnet";
  default: {
    const exhaustive: never = status;
    throw new Error(`Unhandled fresh metadata status: ${exhaustive}`);
  }
  }
};
