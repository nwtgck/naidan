export const ModelSupportInvestigationSession__recording_retention_budget = ({ retainedMiB, retainedCharacters, reservedMiB, reservedCharacters }: { retainedMiB: number; retainedCharacters: number; reservedMiB: number; reservedCharacters: number }): string => (
  `Orçamento de registro — retido: ${retainedMiB} MiB binários, ${retainedCharacters} caracteres JSON; reservado: ${reservedMiB} MiB binários, ${reservedCharacters} caracteres JSON. Limites lógicos, não uma garantia do tamanho do heap.`
);
