export const ModelSupportInvestigationSession__maximum_phase_deadlines = ({ runSeconds, collectionSeconds, sealingSeconds, cleanupSeconds }: { runSeconds: number; collectionSeconds: number; sealingSeconds: number; cleanupSeconds: number }): string => (
  `Prazos máximos: solicitações ${runSeconds}s; coleta ${collectionSeconds}s; evidência ${sealingSeconds}s; limpeza ${cleanupSeconds}s. Limites de segurança, não durações esperadas.`
);
