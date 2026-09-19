export const ModelSupportInvestigationSession__recording_retention_budget = ({ retainedMiB, retainedCharacters, reservedMiB, reservedCharacters }: { retainedMiB: number; retainedCharacters: number; reservedMiB: number; reservedCharacters: number }): string => (
  `记录预算 — 已保留：二进制 ${retainedMiB} MiB，JSON ${retainedCharacters} 个字符；已预留：二进制 ${reservedMiB} MiB，JSON ${reservedCharacters} 个字符。仅为逻辑限制，不保证堆内存大小。`
);
