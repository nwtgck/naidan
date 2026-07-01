import type { SourceSpan } from './syntax';

export type CalculatorDiagnosticCode =
  | 'empty_input'
  | 'input_too_long'
  | 'invalid_character'
  | 'invalid_number'
  | 'unexpected_token'
  | 'missing_token'
  | 'unknown_identifier'
  | 'unknown_function'
  | 'invalid_argument_count'
  | 'invalid_argument'
  | 'domain_error'
  | 'division_by_zero'
  | 'non_finite_result'
  | 'limit_exceeded'
  | 'unknown_help_topic'
  | 'invalid_help_usage';

export type CalculatorDiagnostic = {
  readonly code: CalculatorDiagnosticCode,
  readonly message: string,
  readonly span: SourceSpan | undefined,
  readonly hint: string | undefined,
};

export class CalculatorInputFailure extends Error {
  readonly diagnostic: CalculatorDiagnostic;

  constructor({ diagnostic }: { diagnostic: CalculatorDiagnostic }) {
    super(diagnostic.message);
    this.name = 'CalculatorInputFailure';
    this.diagnostic = diagnostic;
  }
}

export function failCalculatorInput({
  code,
  message,
  span,
  hint,
}: CalculatorDiagnostic): never {
  throw new CalculatorInputFailure({
    diagnostic: {
      code,
      message,
      span,
      hint,
    },
  });
}

function getLineAndColumn({ source, offset }: {
  source: string,
  offset: number,
}): { line: number, column: number, lineStart: number, lineEnd: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  const newlineIndex = source.indexOf('\n', lineStart);
  return {
    line,
    column: offset - lineStart + 1,
    lineStart,
    lineEnd: newlineIndex === -1 ? source.length : newlineIndex,
  };
}

export function formatCalculatorDiagnostic({
  source,
  diagnostic,
}: {
  source: string,
  diagnostic: CalculatorDiagnostic,
}): string {
  const lines = [`Calculator error [${diagnostic.code}]: ${diagnostic.message}`];
  if (diagnostic.span !== undefined) {
    const location = getLineAndColumn({
      source,
      offset: diagnostic.span.start,
    });
    const sourceLine = source.slice(location.lineStart, location.lineEnd);
    const markerLength = Math.max(1, Math.min(
      diagnostic.span.end - diagnostic.span.start,
      Math.max(1, sourceLine.length - (location.column - 1)),
    ));
    lines.push(
      `At line ${location.line}, column ${location.column}:`,
      sourceLine,
      `${' '.repeat(Math.max(0, location.column - 1))}${'^'.repeat(markerLength)}`,
    );
  }
  if (diagnostic.hint !== undefined) {
    lines.push(`Hint: ${diagnostic.hint}`);
  }
  return lines.join('\n');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
