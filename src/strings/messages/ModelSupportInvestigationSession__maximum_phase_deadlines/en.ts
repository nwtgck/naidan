export const ModelSupportInvestigationSession__maximum_phase_deadlines = ({ runSeconds, collectionSeconds, sealingSeconds, cleanupSeconds }: { runSeconds: number; collectionSeconds: number; sealingSeconds: number; cleanupSeconds: number }): string => (
  `Maximum deadlines: requests ${runSeconds}s; collection ${collectionSeconds}s; evidence preparation ${sealingSeconds}s; cleanup ${cleanupSeconds}s. These are safety limits, not expected durations.`
);
