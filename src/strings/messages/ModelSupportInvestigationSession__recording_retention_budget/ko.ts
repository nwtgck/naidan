export const ModelSupportInvestigationSession__recording_retention_budget = ({ retainedMiB, retainedCharacters, reservedMiB, reservedCharacters }: { retainedMiB: number; retainedCharacters: number; reservedMiB: number; reservedCharacters: number }): string => (
  `기록 예산 — 보관: 바이너리 ${retainedMiB} MiB, JSON ${retainedCharacters}자; 예약: 바이너리 ${reservedMiB} MiB, JSON ${reservedCharacters}자. 논리적 한도이며 힙 크기를 보장하지 않습니다.`
);
