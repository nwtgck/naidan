export class XxdOperandError extends Error {
  readonly operand: string;

  constructor({ operand, cause }: { operand: string, cause: unknown }) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'XxdOperandError';
    this.operand = operand;
  }
}

export async function withXxdOperandError<T>({
  operand,
  operation,
}: {
  operand: string,
  operation: () => Promise<T>,
}): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw new XxdOperandError({ operand, cause: error });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
