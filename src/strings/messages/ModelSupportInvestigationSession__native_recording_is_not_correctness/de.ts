export const ModelSupportInvestigationSession__native_recording_is_not_correctness = ({ recording }: { recording: 'not-recorded' | 'partial' | 'recorded' }): string => {
  const labels = {"not-recorded":"Keine native Aufzeichnung gespeichert","partial":"Aufzeichnung mit bekannten Lücken","recorded":"Keine zusätzlichen Lücken im begrenzten Datensatz erkannt"};
  return `Native Aufzeichnung: ${labels[recording]}. Aufzeichnungen und erfüllte Anfragen bestätigen weder korrekte Antworten noch vollständige Reproduzierbarkeit.`;
};
