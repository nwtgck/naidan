export const ModelSupportInvestigationSession__maximum_phase_deadlines = ({ runSeconds, collectionSeconds, sealingSeconds, cleanupSeconds }: { runSeconds: number; collectionSeconds: number; sealingSeconds: number; cleanupSeconds: number }): string => (
  `Plazos máximos: solicitudes ${runSeconds}s; recopilación ${collectionSeconds}s; evidencia ${sealingSeconds}s; limpieza ${cleanupSeconds}s. Son límites de seguridad, no duraciones previstas.`
);
