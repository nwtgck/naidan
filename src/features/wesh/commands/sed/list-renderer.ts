import type { WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { encodeCommandDataText } from '@/features/wesh/commands/_shared/data-codec';

export function renderSedList({
  text,
  width,
  continuationSeparator,
  characterLocaleMode,
}: {
  text: string;
  width: number | undefined;
  continuationSeparator: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  const maximumWidth = width ?? 70;
  const contentWidth = Math.max(0, maximumWidth - 1);
  let output = '';
  let currentLineLength = 0;

  const appendToken = ({ token }: { token: string }): void => {
    if (
      maximumWidth !== 0 &&
      currentLineLength + token.length > contentWidth
    ) {
      output += `\\${continuationSeparator}`;
      currentLineLength = 0;
    }
    output += token;
    currentLineLength += token.length;
  };

  for (const character of text) {
    const token = (() => {
      switch (character) {
      case '\\':
        return '\\\\';
      case '\u0007':
        return '\\a';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\v':
        return '\\v';
      default: {
        const codePoint = character.codePointAt(0);
        if (
          codePoint !== undefined &&
          codePoint >= 0x20 &&
          codePoint <= 0x7e
        ) {
          return character;
        }
        return undefined;
      }
      }
    })();
    if (token !== undefined) {
      appendToken({ token });
      continue;
    }
    switch (characterLocaleMode) {
    case 'ascii':
      appendToken({
        token: `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`,
      });
      break;
    case 'unicode':
      for (const byte of encodeCommandDataText({ text: character })) {
        appendToken({
          token: `\\${byte.toString(8).padStart(3, '0')}`,
        });
      }
      break;
    default: {
      const _ex: never = characterLocaleMode;
      throw new Error(`Unhandled sed character locale mode: ${_ex}`);
    }
    }
  }
  output += '$';
  return output;
}

export const TEST_ONLY = {
};
