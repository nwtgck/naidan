import { decodeShellAnsiCQuote } from './ansi-c-quote';
import {
  findShellAnsiCQuotedEnd,
  findShellWordConstructEnd,
  isShellDoubleQuotedBackslashEscapeTarget,
} from './scan';

type ShellWordQuoteMode = 'unquoted' | 'single' | 'double';

export interface ParsedShellWordPart {
  text: string,
  quoted: boolean,
  expandVariables: boolean,
}

function wordPartMetadata({ mode }: { mode: ShellWordQuoteMode }): {
  quoted: boolean,
  expandVariables: boolean,
} {
  switch (mode) {
  case 'unquoted':
    return {
      quoted: false,
      expandVariables: true,
    };
  case 'single':
    return {
      quoted: true,
      expandVariables: false,
    };
  case 'double':
    return {
      quoted: true,
      expandVariables: true,
    };
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled shell word quote mode: ${_ex}`);
  }
  }
}

function appendWordPart({
  parts,
  text,
  mode,
}: {
  parts: ParsedShellWordPart[],
  text: string,
  mode: ShellWordQuoteMode,
}): void {
  const metadata = wordPartMetadata({ mode });
  parts.push({
    text,
    quoted: metadata.quoted,
    expandVariables: metadata.expandVariables,
  });
}

export function parseShellWordParts({ raw }: { raw: string }): ParsedShellWordPart[] {
  const parts: ParsedShellWordPart[] = [];
  let mode: ShellWordQuoteMode = 'unquoted';
  let current = '';
  let literalStart = 0;

  const appendLiteralRun = ({ endIndex }: { endIndex: number }): void => {
    if (endIndex <= literalStart) return;
    current += raw.slice(literalStart, endIndex);
  };

  const flushCurrent = (): void => {
    appendWordPart({ parts, text: current, mode });
    current = '';
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === undefined) continue;

    const currentMode: ShellWordQuoteMode = mode;
    const constructEnd = (() => {
      switch (currentMode) {
      case 'single':
        return undefined;
      case 'double':
      case 'unquoted':
        return findShellWordConstructEnd({ text: raw, startIndex: index });
      default: {
        const _ex: never = currentMode;
        throw new Error(`Unhandled shell word quote mode: ${_ex}`);
      }
      }
    })();
    if (constructEnd !== undefined) {
      appendLiteralRun({ endIndex: index });
      current += raw.slice(index, constructEnd + 1);
      index = constructEnd;
      literalStart = constructEnd + 1;
      continue;
    }

    switch (currentMode) {
    case 'single':
      if (character === "'") {
        appendLiteralRun({ endIndex: index });
        flushCurrent();
        mode = 'unquoted';
        literalStart = index + 1;
      }
      continue;
    case 'double':
      if (character === '"') {
        appendLiteralRun({ endIndex: index });
        flushCurrent();
        mode = 'unquoted';
        literalStart = index + 1;
        continue;
      }
      if (character === '\\') {
        const nextCharacter = raw[index + 1];
        if (nextCharacter === '\n') {
          appendLiteralRun({ endIndex: index });
          index += 1;
          literalStart = index + 1;
          continue;
        }
        if (isShellDoubleQuotedBackslashEscapeTarget(nextCharacter)) {
          appendLiteralRun({ endIndex: index });
          flushCurrent();
          appendWordPart({
            parts,
            text: nextCharacter,
            mode: 'double',
          });
          index += 1;
          literalStart = index + 1;
          continue;
        }
      }
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = currentMode;
      throw new Error(`Unhandled shell word quote mode: ${_ex}`);
    }
    }

    if (character === '$' && raw[index + 1] === '"') {
      appendLiteralRun({ endIndex: index });
      if (current.length > 0) flushCurrent();
      mode = 'double';
      index += 1;
      literalStart = index + 1;
      continue;
    }

    if (character === '$' && raw[index + 1] === "'") {
      appendLiteralRun({ endIndex: index });
      if (current.length > 0) flushCurrent();
      const endIndex = findShellAnsiCQuotedEnd({ text: raw, startIndex: index }) ?? raw.length;
      parts.push({
        text: decodeShellAnsiCQuote({ text: raw.slice(index + 2, endIndex) }),
        quoted: true,
        expandVariables: false,
      });
      index = endIndex;
      literalStart = endIndex + 1;
      continue;
    }

    if (character === "'") {
      appendLiteralRun({ endIndex: index });
      if (current.length > 0) flushCurrent();
      mode = 'single';
      literalStart = index + 1;
      continue;
    }
    if (character === '"') {
      appendLiteralRun({ endIndex: index });
      if (current.length > 0) flushCurrent();
      mode = 'double';
      literalStart = index + 1;
      continue;
    }
    if (character === '\\') {
      const nextCharacter = raw[index + 1];
      if (nextCharacter === '\n') {
        appendLiteralRun({ endIndex: index });
        index += 1;
        literalStart = index + 1;
        continue;
      }
      if (nextCharacter !== undefined) {
        appendLiteralRun({ endIndex: index });
        if (current.length > 0) flushCurrent();
        parts.push({
          text: nextCharacter,
          quoted: true,
          expandVariables: false,
        });
        index += 1;
        literalStart = index + 1;
        continue;
      }
    }
  }

  appendLiteralRun({ endIndex: raw.length });
  appendWordPart({ parts, text: current, mode });
  return parts;
}

export function parseDoubleQuotedParameterOperandParts({ raw }: {
  raw: string,
}): ParsedShellWordPart[] {
  type OperandQuoteMode = 'outer-double' | 'inner-double';

  const parts: ParsedShellWordPart[] = [];
  let mode: OperandQuoteMode = 'outer-double';
  let current = '';
  let currentExpandVariables = true;
  let literalStart = 0;

  const flushCurrent = (): void => {
    if (current.length === 0) return;
    parts.push({
      text: current,
      quoted: true,
      expandVariables: currentExpandVariables,
    });
    current = '';
  };

  const appendText = ({ text, expandVariables }: {
    text: string,
    expandVariables: boolean,
  }): void => {
    if (text.length === 0) return;
    if (current.length > 0 && currentExpandVariables !== expandVariables) {
      flushCurrent();
    }
    currentExpandVariables = expandVariables;
    current += text;
  };

  const appendPendingLiteralRun = ({ endIndex }: { endIndex: number }): void => {
    if (endIndex <= literalStart) return;
    appendText({
      text: raw.slice(literalStart, endIndex),
      expandVariables: true,
    });
  };

  const appendLiteral = ({ text }: { text: string }): void => {
    appendText({ text, expandVariables: false });
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === undefined) continue;

    switch (mode) {
    case 'outer-double':
    case 'inner-double':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled parameter operand quote mode: ${_ex}`);
    }
    }

    if (character === '$') {
      if (raw[index + 1] === '"') {
        appendPendingLiteralRun({ endIndex: index });
        literalStart = index + 1;
        continue;
      }

      if (mode === 'outer-double' && raw[index + 1] === "'") {
        appendPendingLiteralRun({ endIndex: index });
        flushCurrent();
        const endIndex = findShellAnsiCQuotedEnd({ text: raw, startIndex: index }) ?? raw.length;
        parts.push({
          text: decodeShellAnsiCQuote({ text: raw.slice(index + 2, endIndex) }),
          quoted: true,
          expandVariables: false,
        });
        index = endIndex;
        literalStart = endIndex + 1;
        continue;
      }
    }

    const constructEnd = findShellWordConstructEnd({ text: raw, startIndex: index });
    if (constructEnd !== undefined) {
      index = constructEnd;
      continue;
    }

    if (character === '"') {
      appendPendingLiteralRun({ endIndex: index });
      flushCurrent();
      switch (mode) {
      case 'outer-double':
        mode = 'inner-double';
        break;
      case 'inner-double':
        mode = 'outer-double';
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled parameter operand quote mode: ${_ex}`);
      }
      }
      literalStart = index + 1;
      continue;
    }

    if (character === '\\') {
      const nextCharacter = raw[index + 1];
      if (nextCharacter === '\n') {
        appendPendingLiteralRun({ endIndex: index });
        flushCurrent();
        index += 1;
        literalStart = index + 1;
        continue;
      }
      switch (mode) {
      case 'inner-double':
        if (nextCharacter !== undefined) {
          appendPendingLiteralRun({ endIndex: index });
          appendLiteral({ text: nextCharacter });
          index += 1;
          literalStart = index + 1;
          continue;
        }
        break;
      case 'outer-double':
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled parameter operand quote mode: ${_ex}`);
      }
      }
      if (
        isShellDoubleQuotedBackslashEscapeTarget(nextCharacter) ||
        nextCharacter === '}'
      ) {
        appendPendingLiteralRun({ endIndex: index });
        appendLiteral({ text: nextCharacter });
        index += 1;
        literalStart = index + 1;
        continue;
      }
    }
  }

  appendPendingLiteralRun({ endIndex: raw.length });
  flushCurrent();
  if (parts.length === 0) {
    parts.push({
      text: '',
      quoted: true,
      expandVariables: true,
    });
  }
  return parts;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
