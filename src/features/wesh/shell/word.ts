import { decodeShellAnsiCQuote } from './ansi-c-quote';
import { findBackquoteSubstitution, findBalancedArithmeticExpression, findBalancedParenthesizedExpression, findBracedParameterEnd } from './scan';

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

  const flushCurrent = (): void => {
    appendWordPart({ parts, text: current, mode });
    current = '';
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === undefined) continue;

    const currentMode: ShellWordQuoteMode = mode;
    if (currentMode !== 'single' && character === '`') {
      const substitution = findBackquoteSubstitution({
        text: raw,
        startIndex: index,
      });
      if (substitution !== undefined) {
        current += raw.slice(index, substitution.endIndex + 1);
        index = substitution.endIndex;
        continue;
      }
    }
    if (currentMode !== 'single' && character === '$') {
      if (raw[index + 1] === '{') {
        const endIndex = findBracedParameterEnd({
          text: raw,
          startIndex: index,
        });
        if (endIndex >= 0) {
          current += raw.slice(index, endIndex + 1);
          index = endIndex;
          continue;
        }
      }
      if (raw[index + 1] === '(') {
        const arithmetic = raw[index + 2] === '('
          ? findBalancedArithmeticExpression({
            text: raw,
            startIndex: index,
          })
          : undefined;
        const substitution = arithmetic === undefined
          ? findBalancedParenthesizedExpression({
            text: raw,
            startIndex: index + 1,
          })
          : undefined;
        const endIndex = arithmetic?.endIndex ?? substitution?.endIndex;
        if (endIndex !== undefined) {
          current += raw.slice(index, endIndex + 1);
          index = endIndex;
          continue;
        }
      }
    }

    switch (currentMode) {
    case 'single':
      if (character === "'") {
        flushCurrent();
        mode = 'unquoted';
      } else {
        current += character;
      }
      continue;
    case 'double':
      if (character === '"') {
        flushCurrent();
        mode = 'unquoted';
        continue;
      }
      if (character === '\\') {
        const nextCharacter = raw[index + 1];
        if (nextCharacter === '\n') {
          index += 1;
          continue;
        }
        if (nextCharacter !== undefined && ['\\', '"', '$', '`'].includes(nextCharacter)) {
          flushCurrent();
          appendWordPart({
            parts,
            text: nextCharacter,
            mode: 'double',
          });
          index += 1;
          continue;
        }
      }
      current += character;
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = currentMode;
      throw new Error(`Unhandled shell word quote mode: ${_ex}`);
    }
    }

    if (character === '$' && raw[index + 1] === "'") {
      if (current.length > 0) flushCurrent();
      let cursor = index + 2;
      let content = '';
      while (cursor < raw.length) {
        const ansiCharacter = raw[cursor];
        if (ansiCharacter === "'") break;
        if (ansiCharacter === '\\' && raw[cursor + 1] !== undefined) {
          content += ansiCharacter + raw[cursor + 1];
          cursor += 2;
          continue;
        }
        content += ansiCharacter ?? '';
        cursor += 1;
      }
      parts.push({
        text: decodeShellAnsiCQuote({ text: content }),
        quoted: true,
        expandVariables: false,
      });
      index = cursor;
      continue;
    }

    if (character === "'") {
      if (current.length > 0) flushCurrent();
      mode = 'single';
      continue;
    }
    if (character === '"') {
      if (current.length > 0) flushCurrent();
      mode = 'double';
      continue;
    }
    if (character === '\\') {
      const nextCharacter = raw[index + 1];
      if (nextCharacter === '\n') {
        index += 1;
        continue;
      }
      if (nextCharacter !== undefined) {
        if (current.length > 0) flushCurrent();
        parts.push({
          text: nextCharacter,
          quoted: true,
          expandVariables: false,
        });
        index += 1;
        continue;
      }
    }

    current += character;
  }

  appendWordPart({ parts, text: current, mode });
  return parts;
}

export function parseDoubleQuotedParameterOperandParts({ raw }: {
  raw: string,
}): ParsedShellWordPart[] {
  const parts: ParsedShellWordPart[] = [];
  let current = '';

  const flushExpandable = (): void => {
    if (current.length === 0) return;
    parts.push({
      text: current,
      quoted: true,
      expandVariables: true,
    });
    current = '';
  };

  const appendLiteral = ({ text }: { text: string }): void => {
    flushExpandable();
    parts.push({
      text,
      quoted: true,
      expandVariables: false,
    });
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === undefined) continue;

    if (character === '`') {
      const substitution = findBackquoteSubstitution({
        text: raw,
        startIndex: index,
      });
      if (substitution !== undefined) {
        current += raw.slice(index, substitution.endIndex + 1);
        index = substitution.endIndex;
        continue;
      }
    }

    if (character === '$') {
      if (raw[index + 1] === "'") {
        flushExpandable();
        let cursor = index + 2;
        let content = '';
        while (cursor < raw.length) {
          const ansiCharacter = raw[cursor];
          if (ansiCharacter === "'") break;
          if (ansiCharacter === '\\' && raw[cursor + 1] !== undefined) {
            content += ansiCharacter + raw[cursor + 1];
            cursor += 2;
            continue;
          }
          content += ansiCharacter ?? '';
          cursor += 1;
        }
        parts.push({
          text: decodeShellAnsiCQuote({ text: content }),
          quoted: true,
          expandVariables: false,
        });
        index = cursor;
        continue;
      }

      if (raw[index + 1] === '{') {
        const endIndex = findBracedParameterEnd({
          text: raw,
          startIndex: index,
        });
        if (endIndex >= 0) {
          current += raw.slice(index, endIndex + 1);
          index = endIndex;
          continue;
        }
      }

      if (raw[index + 1] === '(') {
        const arithmetic = raw[index + 2] === '('
          ? findBalancedArithmeticExpression({
            text: raw,
            startIndex: index,
          })
          : undefined;
        const substitution = arithmetic === undefined
          ? findBalancedParenthesizedExpression({
            text: raw,
            startIndex: index + 1,
          })
          : undefined;
        const endIndex = arithmetic?.endIndex ?? substitution?.endIndex;
        if (endIndex !== undefined) {
          current += raw.slice(index, endIndex + 1);
          index = endIndex;
          continue;
        }
      }
    }

    if (character === '"') {
      flushExpandable();
      continue;
    }

    if (character === '\\') {
      const nextCharacter = raw[index + 1];
      if (nextCharacter === '\n') {
        flushExpandable();
        index += 1;
        continue;
      }
      if (
        nextCharacter !== undefined &&
        ['\\', '"', '$', '`', '}'].includes(nextCharacter)
      ) {
        appendLiteral({ text: nextCharacter });
        index += 1;
        continue;
      }
    }

    current += character;
  }

  flushExpandable();
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
