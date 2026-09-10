export const ModelSupportInvestigationSession__native_recording_is_not_correctness = ({ recording }: { recording: 'not-recorded' | 'partial' | 'recorded' }): string => {
  const labels = {"not-recorded":"Nenhum registro nativo retido","partial":"Registro com lacunas explícitas","recorded":"Nenhuma lacuna adicional detectada no registro limitado"};
  return `Registro nativo: ${labels[recording]}. Registros e solicitações concluídas não certificam respostas corretas nem reprodução completa.`;
};
