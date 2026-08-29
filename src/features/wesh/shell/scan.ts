import { decodeShellAnsiCQuote } from './ansi-c-quote';

type ShellQuoteMode = 'unquoted' | 'single' | 'double';

const SHELL_WORD_BOUNDARY_CHARACTERS = ';&|<>()';
const DOUBLE_QUOTED_BACKSLASH_ESCAPABLE_CHARACTERS = '$`"\\';

export interface BalancedShellExpression {
  content: string,
  endIndex: number,
}

interface PendingHereDocument {
  delimiter: string,
  tabHandling: 'preserve' | 'strip-leading',
}

// Heredoc delimiter words are quote-removed but not expanded. Shell-looking
// constructs therefore remain literal text, while still needing balanced lexical
// scanning so metacharacters inside them do not terminate the delimiter word.
function findShellWordConstructEnd({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): number | undefined {
  if (text[startIndex] === '`') {
    return findBackquoteSubstitution({ text, startIndex })?.endIndex;
  }
  if (text[startIndex] !== '$') return undefined;

  if (text[startIndex + 1] === '{') {
    const endIndex = findBracedParameterEnd({ text, startIndex });
    return endIndex < 0 ? undefined : endIndex;
  }
  if (text[startIndex + 1] !== '(') return undefined;
  const expression = text[startIndex + 2] === '('
    ? findBalancedArithmeticExpression({ text, startIndex })
    : findBalancedParenthesizedExpression({ text, startIndex: startIndex + 1 });
  return expression?.endIndex;
}

function findAnsiCQuotedEnd({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): number | undefined {
  if (text[startIndex] !== '$' || text[startIndex + 1] !== "'") return undefined;

  for (let index = startIndex + 2; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;
    if (character === "'") return index;
    if (character === '\\' && text[index + 1] !== undefined) index += 1;
  }
  return undefined;
}

function scanAnsiCQuotedDelimiterPart({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): {
  endIndex: number,
  value: string,
} | undefined {
  const endIndex = findAnsiCQuotedEnd({ text, startIndex });
  if (endIndex === undefined) return undefined;
  return {
    endIndex,
    value: decodeShellAnsiCQuote({ text: text.slice(startIndex + 2, endIndex) }),
  };
}

function scanHereDocumentDeclaration({
  text,
  operatorIndex,
}: {
  text: string,
  operatorIndex: number,
}): {
  endIndex: number,
  pending: PendingHereDocument,
} | undefined {
  if (text.slice(operatorIndex, operatorIndex + 2) !== '<<') return undefined;
  if (text[operatorIndex + 2] === '<') return undefined;

  const tabHandling = text[operatorIndex + 2] === '-'
    ? 'strip-leading' as const
    : 'preserve' as const;
  let index: number;
  switch (tabHandling) {
  case 'preserve':
    index = operatorIndex + 2;
    break;
  case 'strip-leading':
    index = operatorIndex + 3;
    break;
  default: {
    const _ex: never = tabHandling;
    throw new Error(`Unhandled heredoc tab handling: ${_ex}`);
  }
  }
  while (text[index] === ' ' || text[index] === '\t') index += 1;

  const firstCharacter = text[index];
  if (
    firstCharacter === undefined ||
    firstCharacter === '\n' ||
    firstCharacter === '#' ||
    SHELL_WORD_BOUNDARY_CHARACTERS.includes(firstCharacter)
  ) {
    return undefined;
  }

  let delimiter = '';
  let mode: ShellQuoteMode = 'unquoted';
  let consumed = false;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;

    switch (mode) {
    case 'single':
      consumed = true;
      if (character === "'") {
        mode = 'unquoted';
      } else {
        delimiter += character;
      }
      continue;
    case 'double': {
      consumed = true;
      const constructEnd = findShellWordConstructEnd({ text, startIndex: index });
      if (constructEnd !== undefined) {
        delimiter += text.slice(index, constructEnd + 1);
        index = constructEnd;
        continue;
      }
      if (character === '"') {
        mode = 'unquoted';
        continue;
      }
      if (character === '\\') {
        const nextCharacter = text[index + 1];
        if (nextCharacter === '\n') {
          index += 1;
          continue;
        }
        if (
          nextCharacter !== undefined &&
          DOUBLE_QUOTED_BACKSLASH_ESCAPABLE_CHARACTERS.includes(nextCharacter)
        ) {
          delimiter += nextCharacter;
          index += 1;
          continue;
        }
        delimiter += character;
        continue;
      }
      delimiter += character;
      continue;
    }
    case 'unquoted':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled shell quote mode: ${_ex}`);
    }
    }

    const ansiCQuoted = scanAnsiCQuotedDelimiterPart({ text, startIndex: index });
    if (ansiCQuoted !== undefined) {
      consumed = true;
      delimiter += ansiCQuoted.value;
      index = ansiCQuoted.endIndex;
      continue;
    }

    if (character === '$' && text[index + 1] === '"') {
      consumed = true;
      mode = 'double';
      index += 1;
      continue;
    }

    const constructEnd = findShellWordConstructEnd({ text, startIndex: index });
    if (constructEnd !== undefined) {
      consumed = true;
      delimiter += text.slice(index, constructEnd + 1);
      index = constructEnd;
      continue;
    }

    if (
      character === ' ' ||
      character === '\t' ||
      character === '\n' ||
      SHELL_WORD_BOUNDARY_CHARACTERS.includes(character)
    ) {
      break;
    }
    consumed = true;
    if (character === "'") {
      mode = 'single';
      continue;
    }
    if (character === '"') {
      mode = 'double';
      continue;
    }
    if (character === '\\') {
      const nextCharacter = text[index + 1];
      if (nextCharacter !== undefined) {
        if (nextCharacter !== '\n') delimiter += nextCharacter;
        index += 1;
      }
      continue;
    }
    delimiter += character;
  }

  if (!consumed || mode !== 'unquoted') return undefined;
  return {
    endIndex: index - 1,
    pending: { delimiter, tabHandling },
  };
}

// Once the command-line newline is reached, pending heredoc bodies are data,
// not syntax of the surrounding command/process substitution. Skip them before
// resuming parenthesis balancing.
function skipPendingHereDocumentBodies({
  text,
  newlineIndex,
  pending,
}: {
  text: string,
  newlineIndex: number,
  pending: readonly PendingHereDocument[],
}): number | undefined {
  let cursor = newlineIndex + 1;
  for (const hereDocument of pending) {
    let foundDelimiter = false;
    while (cursor <= text.length) {
      const lineEnd = text.indexOf('\n', cursor);
      const boundedLineEnd = lineEnd < 0 ? text.length : lineEnd;
      const rawLine = text.slice(cursor, boundedLineEnd);
      let line: string;
      switch (hereDocument.tabHandling) {
      case 'preserve':
        line = rawLine;
        break;
      case 'strip-leading':
        line = rawLine.replace(/^\t+/u, '');
        break;
      default: {
        const _ex: never = hereDocument.tabHandling;
        throw new Error(`Unhandled heredoc tab handling: ${_ex}`);
      }
      }
      if (line === hereDocument.delimiter) {
        cursor = boundedLineEnd + (lineEnd < 0 ? 0 : 1);
        foundDelimiter = true;
        break;
      }
      if (lineEnd < 0) break;
      cursor = lineEnd + 1;
    }
    if (!foundDelimiter) return undefined;
  }
  return cursor;
}

export function findBackquoteSubstitution({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): BalancedShellExpression | undefined {
  if (text[startIndex] !== '`') return undefined;

  let escaped = false;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '`') {
      return {
        content: text.slice(startIndex + 1, index),
        endIndex: index,
      };
    }
  }
  return undefined;
}

export function findBalancedParenthesizedExpression({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): BalancedShellExpression | undefined {
  if (text[startIndex] !== '(') return undefined;

  let depth = 0;
  let mode: ShellQuoteMode = 'unquoted';
  let atWordStart = true;
  let pendingHereDocuments: PendingHereDocument[] | undefined;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;

    switch (mode) {
    case 'single':
      if (character === "'") mode = 'unquoted';
      continue;
    case 'double':
      if (character === '"') {
        mode = 'unquoted';
        continue;
      }
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '`') {
        const substitution = findBackquoteSubstitution({ text, startIndex: index });
        if (substitution !== undefined) index = substitution.endIndex;
        continue;
      }
      if (character === '$' && text[index + 1] === '{') {
        const endIndex = findBracedParameterEnd({
          text,
          startIndex: index,
        });
        if (endIndex >= 0) index = endIndex;
        continue;
      }
      if (character === '$' && text[index + 1] === '(') {
        const expression = text[index + 2] === '('
          ? findBalancedArithmeticExpression({ text, startIndex: index })
          : findBalancedParenthesizedExpression({ text, startIndex: index + 1 });
        if (expression !== undefined) index = expression.endIndex;
      }
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled shell quote mode: ${_ex}`);
    }
    }

    const ansiCQuotedEnd = findAnsiCQuotedEnd({ text, startIndex: index });
    if (ansiCQuotedEnd !== undefined) {
      index = ansiCQuotedEnd;
      atWordStart = false;
      continue;
    }

    if (character === '#') {
      if (atWordStart) {
        while (index + 1 < text.length) {
          const nextCharacter = text[index + 1];
          if (nextCharacter === '\n') break;
          index += 1;
        }
        atWordStart = true;
        continue;
      }
      atWordStart = false;
    }
    if (character === '`') {
      const substitution = findBackquoteSubstitution({ text, startIndex: index });
      if (substitution !== undefined) {
        index = substitution.endIndex;
        atWordStart = false;
        continue;
      }
    }
    if (character === '$' && text[index + 1] === '{') {
      const endIndex = findBracedParameterEnd({
        text,
        startIndex: index,
      });
      if (endIndex >= 0) {
        index = endIndex;
        atWordStart = false;
        continue;
      }
    }
    if (character === '$' && text[index + 1] === '(') {
      const expression = text[index + 2] === '('
        ? findBalancedArithmeticExpression({ text, startIndex: index })
        : findBalancedParenthesizedExpression({ text, startIndex: index + 1 });
      if (expression !== undefined) {
        index = expression.endIndex;
        atWordStart = false;
        continue;
      }
    }
    if (atWordStart && character === '(' && text[index + 1] === '(') {
      const arithmeticCommand = findBalancedArithmeticCommand({ text, startIndex: index });
      if (arithmeticCommand !== undefined) {
        index = arithmeticCommand.endIndex;
        atWordStart = false;
        continue;
      }
    }
    if (character === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      const declaration = scanHereDocumentDeclaration({ text, operatorIndex: index });
      if (declaration !== undefined) {
        (pendingHereDocuments ??= []).push(declaration.pending);
        index = declaration.endIndex;
        atWordStart = false;
        continue;
      }
    }
    if (character === "'") {
      mode = 'single';
      atWordStart = false;
      continue;
    }
    if (character === '"') {
      mode = 'double';
      atWordStart = false;
      continue;
    }
    if (character === '\\') {
      const nextCharacter = text[index + 1];
      if (nextCharacter === '\n') {
        index += 1;
        continue;
      }
      if (nextCharacter !== undefined) {
        atWordStart = false;
        index += 1;
      }
      continue;
    }
    if (character === '\n' && pendingHereDocuments !== undefined) {
      const nextIndex = skipPendingHereDocumentBodies({
        text,
        newlineIndex: index,
        pending: pendingHereDocuments,
      });
      if (nextIndex === undefined) return undefined;
      pendingHereDocuments = undefined;
      index = nextIndex - 1;
      atWordStart = true;
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\n') {
      atWordStart = true;
      continue;
    }
    if (character === '(') {
      depth += 1;
      atWordStart = true;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.slice(startIndex + 1, index),
          endIndex: index,
        };
      }
      atWordStart = true;
      continue;
    }
    if (character === ';' || character === '&' || character === '|' || character === '<' || character === '>') {
      atWordStart = true;
      continue;
    }
    atWordStart = false;
  }
  return undefined;
}

function findBalancedArithmeticBody({
  text,
  contentStartIndex,
}: {
  text: string,
  contentStartIndex: number,
}): BalancedShellExpression | undefined {
  let depth = 1;
  let mode: ShellQuoteMode = 'unquoted';
  for (let index = contentStartIndex; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];
    if (character === undefined) continue;

    switch (mode) {
    case 'single':
      if (character === "'") mode = 'unquoted';
      continue;
    case 'double':
      if (character === '"') {
        mode = 'unquoted';
        continue;
      }
      if (character === '\\') index += 1;
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled shell quote mode: ${_ex}`);
    }
    }

    // Nested substitutions own their quote, comment, and heredoc syntax. Skip the
    // complete construct before counting parentheses in the outer arithmetic body.
    const constructEnd = findShellWordConstructEnd({ text, startIndex: index });
    if (constructEnd !== undefined) {
      index = constructEnd;
      continue;
    }

    const ansiCQuotedEnd = findAnsiCQuotedEnd({ text, startIndex: index });
    if (ansiCQuotedEnd !== undefined) {
      index = ansiCQuotedEnd;
      continue;
    }

    if (character === "'") {
      mode = 'single';
      continue;
    }
    if (character === '"') {
      mode = 'double';
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      if (depth > 1) {
        depth -= 1;
        continue;
      }
      if (nextCharacter === ')') {
        return {
          content: text.slice(contentStartIndex, index),
          endIndex: index + 1,
        };
      }
    }
  }
  return undefined;
}

export function findBalancedArithmeticExpression({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): BalancedShellExpression | undefined {
  if (text.slice(startIndex, startIndex + 3) !== '$((') return undefined;
  return findBalancedArithmeticBody({
    text,
    contentStartIndex: startIndex + 3,
  });
}

function findBalancedArithmeticCommand({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): BalancedShellExpression | undefined {
  if (text.slice(startIndex, startIndex + 2) !== '((') return undefined;
  return findBalancedArithmeticBody({
    text,
    contentStartIndex: startIndex + 2,
  });
}

export function findBracedParameterEnd({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): number {
  if (text.slice(startIndex, startIndex + 2) !== '${') return -1;

  let depth = 1;
  let mode: ShellQuoteMode = 'unquoted';
  for (let index = startIndex + 2; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;

    switch (mode) {
    case 'single':
      if (character === "'") mode = 'unquoted';
      continue;
    case 'double':
      if (character === '"') {
        mode = 'unquoted';
        continue;
      }
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '`') {
        const substitution = findBackquoteSubstitution({ text, startIndex: index });
        if (substitution !== undefined) {
          index = substitution.endIndex;
          continue;
        }
      }
      if (character !== '$') continue;
      break;
    case 'unquoted': {
      const ansiCQuotedEnd = findAnsiCQuotedEnd({ text, startIndex: index });
      if (ansiCQuotedEnd !== undefined) {
        index = ansiCQuotedEnd;
        continue;
      }
      if (character === '`') {
        const substitution = findBackquoteSubstitution({ text, startIndex: index });
        if (substitution !== undefined) {
          index = substitution.endIndex;
          continue;
        }
      }
      if (character === "'") {
        mode = 'single';
        continue;
      }
      if (character === '"') {
        mode = 'double';
        continue;
      }
      break;
    }
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled shell quote mode: ${_ex}`);
    }
    }

    if (character === '\\') {
      index += 1;
      continue;
    }
    if (
      (character === '<' || character === '>') &&
      text[index + 1] === '('
    ) {
      const processSubstitution = findBalancedParenthesizedExpression({
        text,
        startIndex: index + 1,
      });
      if (processSubstitution !== undefined) index = processSubstitution.endIndex;
      continue;
    }
    if (character === '$' && text[index + 1] === '(') {
      if (text[index + 2] === '(') {
        const arithmetic = findBalancedArithmeticExpression({ text, startIndex: index });
        if (arithmetic !== undefined) index = arithmetic.endIndex;
        continue;
      }
      const substitution = findBalancedParenthesizedExpression({ text, startIndex: index + 1 });
      if (substitution !== undefined) index = substitution.endIndex;
      continue;
    }
    if (character === '$' && text[index + 1] === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}


export function nextShellCharacterIndex({
  text,
  index,
}: {
  text: string,
  index: number,
}): number {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) {
    return index;
  }
  return index + (codePoint > 0xffff ? 2 : 1);
}

export function previousShellCharacterIndex({
  text,
  index,
}: {
  text: string,
  index: number,
}): number {
  if (index <= 0) {
    return 0;
  }

  const trailingCodeUnit = text.charCodeAt(index - 1);
  if (
    trailingCodeUnit >= 0xdc00 &&
    trailingCodeUnit <= 0xdfff &&
    index >= 2
  ) {
    const leadingCodeUnit = text.charCodeAt(index - 2);
    if (leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff) {
      return index - 2;
    }
  }

  return index - 1;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
