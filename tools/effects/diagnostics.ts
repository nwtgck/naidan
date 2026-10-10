export type SourceLocation = { file: string, start: number, length: number };
export type EffectDiagnostic = SourceLocation & {
  code: 'syntax' | 'missing' | 'exceeds' | 'unsupported' | 'configuration' | 'typescript' | 'boundary',
  message: string,
  related: readonly (SourceLocation & { message: string })[],
};

export function compareDiagnostics({ left, right }: { left: EffectDiagnostic, right: EffectDiagnostic }): number {
  return left.file.localeCompare(right.file) || left.start - right.start || left.code.localeCompare(right.code) || left.message.localeCompare(right.message);
}
