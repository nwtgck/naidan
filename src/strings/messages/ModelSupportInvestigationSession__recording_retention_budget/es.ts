export const ModelSupportInvestigationSession__recording_retention_budget = ({ retainedMiB, retainedCharacters, reservedMiB, reservedCharacters }: { retainedMiB: number; retainedCharacters: number; reservedMiB: number; reservedCharacters: number }): string => (
  `Presupuesto de registro — conservado: ${retainedMiB} MiB binarios, ${retainedCharacters} caracteres JSON; reservado: ${reservedMiB} MiB binarios, ${reservedCharacters} caracteres JSON. Límites lógicos, no una garantía del tamaño del heap.`
);
