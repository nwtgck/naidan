import { failCalculatorInput } from './diagnostics';
import { CALCULATOR_LIMITS } from './limits';
import type { CalculatorOperator, CalculatorToken, SourceSpan } from './syntax';

function isAsciiDigit({ character }: { character: string | undefined }): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function isIdentifierStart({ character }: { character: string | undefined }): boolean {
  return character !== undefined && character >= 'a' && character <= 'z';
}

function isIdentifierContinuation({ character }: { character: string | undefined }): boolean {
  return isIdentifierStart({ character }) || isAsciiDigit({ character }) || character === '_';
}

function isWhitespace({ character }: { character: string | undefined }): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function makeSpan({ start, end }: { start: number, end: number }): SourceSpan {
  return { start, end };
}

export function tokenizeCalculatorInput({ input }: { input: string }): readonly CalculatorToken[] {
  const tokens: CalculatorToken[] = [];
  let position = 0;

  const pushToken = ({ token }: { token: CalculatorToken }): void => {
    if (tokens.length >= CALCULATOR_LIMITS.maximumTokenCount) {
      failCalculatorInput({
        code: 'limit_exceeded',
        message: `The expression exceeds the maximum of ${CALCULATOR_LIMITS.maximumTokenCount} tokens.`,
        span: token.span,
        hint: 'Split the calculation into smaller expressions.',
      });
    }
    tokens.push(token);
  };

  while (position < input.length) {
    const character = input[position];
    if (isWhitespace({ character })) {
      position += 1;
      continue;
    }

    if (isAsciiDigit({ character }) || (character === '.' && isAsciiDigit({ character: input[position + 1] }))) {
      const start = position;
      while (isAsciiDigit({ character: input[position] })) position += 1;
      if (input[position] === '.') {
        position += 1;
        while (isAsciiDigit({ character: input[position] })) position += 1;
      }
      if (input[position] === 'e' || input[position] === 'E') {
        position += 1;
        if (input[position] === '+' || input[position] === '-') position += 1;
        const exponentStart = position;
        while (isAsciiDigit({ character: input[position] })) position += 1;
        if (position === exponentStart) {
          failCalculatorInput({
            code: 'invalid_number',
            message: 'A scientific-notation exponent must contain at least one digit.',
            span: makeSpan({ start, end: position }),
            hint: 'Use notation such as 1e6 or 2.5e-3.',
          });
        }
      }
      const raw = input.slice(start, position);
      if (raw.length > CALCULATOR_LIMITS.maximumNumericLiteralLength) {
        failCalculatorInput({
          code: 'limit_exceeded',
          message: `A numeric literal exceeds the maximum length of ${CALCULATOR_LIMITS.maximumNumericLiteralLength}.`,
          span: makeSpan({ start, end: position }),
          hint: undefined,
        });
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        failCalculatorInput({
          code: 'invalid_number',
          message: `The numeric literal ${raw} is outside the supported finite range.`,
          span: makeSpan({ start, end: position }),
          hint: 'Use a smaller finite number.',
        });
      }
      pushToken({
        token: {
          type: 'number',
          value,
          span: makeSpan({ start, end: position }),
        },
      });
      continue;
    }

    if (isIdentifierStart({ character })) {
      const start = position;
      position += 1;
      while (isIdentifierContinuation({ character: input[position] })) position += 1;
      const value = input.slice(start, position);
      if (value.length > CALCULATOR_LIMITS.maximumIdentifierLength) {
        failCalculatorInput({
          code: 'limit_exceeded',
          message: `An identifier exceeds the maximum length of ${CALCULATOR_LIMITS.maximumIdentifierLength}.`,
          span: makeSpan({ start, end: position }),
          hint: undefined,
        });
      }
      pushToken({ token: { type: 'identifier', value, span: makeSpan({ start, end: position }) } });
      continue;
    }

    if (character === '+' || character === '-' || character === '*' || character === '/' || character === '%' || character === '^') {
      pushToken({
        token: {
          type: 'operator',
          value: character as CalculatorOperator,
          span: makeSpan({ start: position, end: position + 1 }),
        },
      });
      position += 1;
      continue;
    }

    const simpleTokenType = character === '('
      ? 'left_parenthesis'
      : character === ')'
        ? 'right_parenthesis'
        : character === ','
          ? 'comma'
          : undefined;
    if (simpleTokenType !== undefined) {
      pushToken({
        token: {
          type: simpleTokenType,
          span: makeSpan({ start: position, end: position + 1 }),
        },
      });
      position += 1;
      continue;
    }

    const codePoint = input.codePointAt(position);
    if (codePoint === undefined) {
      throw new Error(`Missing calculator input code point at position ${position}`);
    }
    const invalidCharacter = String.fromCodePoint(codePoint);
    failCalculatorInput({
      code: 'invalid_character',
      message: `The character ${JSON.stringify(invalidCharacter)} is not part of the calculator language.`,
      span: makeSpan({ start: position, end: position + invalidCharacter.length }),
      hint: 'Evaluate `help syntax` for the supported syntax.',
    });
  }

  tokens.push({ type: 'end', span: makeSpan({ start: input.length, end: input.length }) });
  return tokens;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
