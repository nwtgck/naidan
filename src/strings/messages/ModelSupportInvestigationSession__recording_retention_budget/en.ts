export const ModelSupportInvestigationSession__recording_retention_budget = ({ retainedMiB, retainedCharacters, reservedMiB, reservedCharacters }: { retainedMiB: number; retainedCharacters: number; reservedMiB: number; reservedCharacters: number }): string => (
  `Recording budget — retained: ${retainedMiB} MiB binary, ${retainedCharacters} JSON characters; reserved: ${reservedMiB} MiB binary, ${reservedCharacters} JSON characters. Logical limits, not a heap-size guarantee.`
);
