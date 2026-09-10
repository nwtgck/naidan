export const ModelSupportInvestigationSession__maximum_phase_deadlines = ({ runSeconds, collectionSeconds, sealingSeconds, cleanupSeconds }: { runSeconds: number; collectionSeconds: number; sealingSeconds: number; cleanupSeconds: number }): string => (
  `Maximale Fristen: Anfragen ${runSeconds}s; Erfassung ${collectionSeconds}s; Evidenz ${sealingSeconds}s; Bereinigung ${cleanupSeconds}s. Sicherheitsgrenzen, keine erwarteten Laufzeiten.`
);
