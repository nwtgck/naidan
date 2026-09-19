export const ModelSupportInvestigationSession__native_recording_is_not_correctness = ({ recording }: { recording: 'not-recorded' | 'partial' | 'recorded' }): string => {
  const labels = {"not-recorded":"Sin registro nativo conservado","partial":"Registro con carencias explícitas","recorded":"Sin carencias adicionales detectadas en el registro limitado"};
  return `Registro nativo: ${labels[recording]}. Los registros y las solicitudes completadas no certifican respuestas correctas ni una reproducción completa.`;
};
