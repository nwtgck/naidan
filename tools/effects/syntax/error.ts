export class EffectSyntaxError extends Error {
  readonly offset: number;

  constructor({ message, offset }: { message: string, offset: number }) {
    super(message);
    this.name = 'EffectSyntaxError';
    this.offset = offset;
  }
}
