export const ModelSupportInvestigationSession__recording_retention_budget = ({ retainedMiB, retainedCharacters, reservedMiB, reservedCharacters }: { retainedMiB: number; retainedCharacters: number; reservedMiB: number; reservedCharacters: number }): string => (
  `Aufzeichnungsbudget — gespeichert: ${retainedMiB} MiB binär, ${retainedCharacters} JSON-Zeichen; reserviert: ${reservedMiB} MiB binär, ${reservedCharacters} JSON-Zeichen. Logische Grenzen, keine Heap-Garantie.`
);
