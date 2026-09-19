import type { WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import {
  decodeCommandDataBytes,
  decodeCommandDataBytesAsSingleByte,
  encodeCommandDataText,
} from '@/features/wesh/commands/_shared/data-codec';

export function isSingleByteSedDelimiter({ delimiter }: { delimiter: string }): boolean {
  return encodeCommandDataText({ text: delimiter }).byteLength === 1;
}

export function decodeSedDataBytes({
  bytes,
  characterLocaleMode,
}: {
  bytes: Uint8Array;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  switch (characterLocaleMode) {
  case 'ascii':
    return decodeCommandDataBytesAsSingleByte({ bytes });
  case 'unicode':
    return decodeCommandDataBytes({ bytes });
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled sed character locale mode: ${_ex}`);
  }
  }
}

export function toSedLocaleText({
  text,
  characterLocaleMode,
}: {
  text: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  switch (characterLocaleMode) {
  case 'ascii':
    return decodeCommandDataBytesAsSingleByte({
      bytes: encodeCommandDataText({ text }),
    });
  case 'unicode':
    return text;
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled sed character locale mode: ${_ex}`);
  }
  }
}

export function fromSedLocaleText({
  text,
  characterLocaleMode,
}: {
  text: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  switch (characterLocaleMode) {
  case 'ascii': {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index) & 0xff;
    }
    return decodeCommandDataBytes({ bytes });
  }
  case 'unicode':
    return text;
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled sed character locale mode: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
