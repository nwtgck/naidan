import { isShellWhitespaceCharacter } from './ascii';

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
      text: parts.map((part) => part.text).join(''),
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
    const text = parts.map((part) => part.text).join('');
    if (text.length === 0 && !hasQuotedPart) {
      return [];
    }
    return [{ text, parts }];
  }

  const effectiveIfs = ifs ?? ' \t\n';
  const ifsCharacters = new Set(effectiveIfs);
  const fields: WeshExpandedField[] = [];
  let currentText = '';
  let currentParts: WeshExpandedFieldPart[] = [];
  let hasContent = false;
  let pendingNonWhitespaceDelimiter = false;

  const flush = () => {
    if (!hasContent) {
      return;
    }

    fields.push({
      text: currentText,
      parts: currentParts,
    });
    currentText = '';
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
      currentText += part.text;
      currentParts.push(part);
      if (part.text.length > 0 || part.quoted) {
        hasContent = true;
      }
      continue;
    }

    let chunk = '';
    for (const char of part.text) {
      if (ifsCharacters.has(char)) {
        if (chunk.length > 0) {
          currentText += chunk;
          currentParts.push({
            text: chunk,
            quoted: false,
            fieldSplitEligible: true,
          });
          hasContent = true;
          chunk = '';
        }

        if (isShellWhitespaceCharacter({ value: char })) {
          if (hasContent) {
            flush();
          }
          continue;
        }

        if (hasContent) {
          flush();
        } else if (pendingNonWhitespaceDelimiter || fields.length === 0) {
          pushEmptyField();
        }
        pendingNonWhitespaceDelimiter = true;
        continue;
      }
      pendingNonWhitespaceDelimiter = false;
      chunk += char;
    }

    if (chunk.length > 0) {
      currentText += chunk;
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
