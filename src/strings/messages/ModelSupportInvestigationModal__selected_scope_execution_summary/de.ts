export const ModelSupportInvestigationModal__selected_scope_execution_summary = ({ state }: { state: 'running' | 'completed' | 'interrupted' | 'unknown' }): string => {
  switch (state) {
  case 'running': return "Die Untersuchung des gewählten Umfangs läuft. Gesammelte Nachweise können exportiert werden.";
  case 'completed': return "Die Untersuchung des gewählten Umfangs ist beendet. Ergebnisse und Nachweisgrenzen stehen unten.";
  case 'interrupted': return "Die Untersuchung wurde vor Abschluss gestoppt. Gesammelte Nachweise sind verfügbar.";
  case 'unknown': return "Der Abschluss der Untersuchung wurde nicht aufgezeichnet.";
  default: {
    const exhaustive: never = state;
    throw new Error(`Unhandled execution state: ${exhaustive}`);
  }
  }
};
