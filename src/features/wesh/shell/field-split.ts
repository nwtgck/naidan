import { isShellWhitespaceCharacter } from './ascii';

const DEFAULT_IFS = ' \t\n';
const DEFAULT_IFS_CHARACTERS: ReadonlySet<string> = new Set(DEFAULT_IFS);

export type WeshExpansionContext = 'argv' | 'assignment' | 'redirection';

export interface WeshExpandedFieldPart {
  text: string,
  quoted: boolean,
  fieldSplitEligible: boolean,
}

export interface WeshExpandedField {
  text: string,
  parts: WeshExpandedFieldPart[],
}

function joinExpandedFieldParts({
  parts,
}: {
  parts: readonly WeshExpandedFieldPart[],
}): string {
  let text = '';
  for (const part of parts) text += part.text;
  return text;
}

export function splitExpandedFields({
  parts,
  context,
  ifs,
}: {
  parts: WeshExpandedFieldPart[],
  context: WeshExpansionContext,
  ifs: string | undefined,
}): WeshExpandedField[] {
  switch (context) {
  case 'assignment':
  case 'redirection':
    return [{
      text: joinExpandedFieldParts({ parts }),
      parts,
    }];
  case 'argv':
    break;
  default: {
    const _ex: never = context;
    throw new Error(`Unhandled expansion context: ${_ex}`);
  }
  }

  if (ifs === '') {
    const hasQuotedPart = parts.some((part) => part.quoted);
    const text = joinExpandedFieldParts({ parts });
    if (text.length === 0 && !hasQuotedPart) {
      return [];
    }
    return [{ text, parts }];
  }

  const ifsCharacters = ifs === undefined
    ? DEFAULT_IFS_CHARACTERS
    : new Set(ifs);
  const fields: WeshExpandedField[] = [];
  let currentParts: WeshExpandedFieldPart[] = [];
  let hasContent = false;
  let pendingNonWhitespaceDelimiter = false;

  const flush = () => {
    if (!hasContent) {
      return;
    }

    fields.push({
      text: joinExpandedFieldParts({ parts: currentParts }),
      parts: currentParts,
    });
    currentParts = [];
    hasContent = false;
  };

  const pushEmptyField = () => {
    fields.push({
      text: '',
      parts: [],
    });
  };

  for (const part of parts) {
    if (!part.fieldSplitEligible) {
      pendingNonWhitespaceDelimiter = false;
      currentParts.push(part);
      if (part.text.length > 0 || part.quoted) {
        hasContent = true;
      }
      continue;
    }

    let chunkStart = 0;
    let index = 0;
    for (const char of part.text) {
      const nextIndex = index + char.length;
      if (ifsCharacters.has(char)) {
        if (chunkStart < index) {
          const chunk = part.text.slice(chunkStart, index);
          currentParts.push({
            text: chunk,
            quoted: false,
            fieldSplitEligible: true,
          });
          hasContent = true;
        }
        chunkStart = nextIndex;

        if (isShellWhitespaceCharacter({ value: char })) {
          if (hasContent) {
            flush();
          }
          index = nextIndex;
          continue;
        }

        if (hasContent) {
          flush();
        } else if (pendingNonWhitespaceDelimiter || fields.length === 0) {
          pushEmptyField();
        }
        pendingNonWhitespaceDelimiter = true;
        index = nextIndex;
        continue;
      }
      pendingNonWhitespaceDelimiter = false;
      index = nextIndex;
    }

    if (chunkStart < part.text.length) {
      const chunk = part.text.slice(chunkStart);
      currentParts.push({
        text: chunk,
        quoted: false,
        fieldSplitEligible: true,
      });
      hasContent = true;
    }
  }

  flush();
  return fields;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
