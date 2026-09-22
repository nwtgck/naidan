export const ModelSupportInvestigationSession__recording_retention_budget = ({ retainedMiB, retainedCharacters, reservedMiB, reservedCharacters }: { retainedMiB: number; retainedCharacters: number; reservedMiB: number; reservedCharacters: number }): string => (
  `記録の容量 — 保持済み：バイナリ ${retainedMiB} MiB、JSON ${retainedCharacters} 文字。予約済み：バイナリ ${reservedMiB} MiB、JSON ${reservedCharacters} 文字。記録量の制限であり、メモリ使用量の保証ではありません。`
);
