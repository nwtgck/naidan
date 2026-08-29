import type { GitConfig } from "./config";
import { getBooleanConfigValue } from "./config";

const textEncoder = new TextEncoder();

function octalEscape({ byte }: { byte: number }): string {
  return `\\${byte.toString(8).padStart(3, "0")}`;
}

function quoteAsciiByte({ byte }: { byte: number }): { text: string, escaped: boolean } {
  switch (byte) {
  case 0x07:
    return { text: "\\a", escaped: true };
  case 0x08:
    return { text: "\\b", escaped: true };
  case 0x09:
    return { text: "\\t", escaped: true };
  case 0x0a:
    return { text: "\\n", escaped: true };
  case 0x0b:
    return { text: "\\v", escaped: true };
  case 0x0c:
    return { text: "\\f", escaped: true };
  case 0x0d:
    return { text: "\\r", escaped: true };
  case 0x22:
    return { text: "\\\"", escaped: true };
  case 0x5c:
    return { text: "\\\\", escaped: true };
  default:
    if (byte < 0x20 || byte === 0x7f) return { text: octalEscape({ byte }), escaped: true };
    return { text: String.fromCharCode(byte), escaped: false };
  }
}

export function quoteGitPath({ path, quoteNonAscii, quoteSpaces }: {
  path: string,
  quoteNonAscii: boolean,
  quoteSpaces: boolean,
}): string {
  let quoted = false;
  let body = "";
  for (const character of path) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      const escaped = quoteAsciiByte({ byte: codePoint });
      body += escaped.text;
      quoted ||= escaped.escaped || (quoteSpaces && codePoint === 0x20);
      continue;
    }
    if (!quoteNonAscii) {
      body += character;
      continue;
    }
    quoted = true;
    for (const byte of textEncoder.encode(character)) body += octalEscape({ byte });
  }
  return quoted ? `"${body}"` : body;
}

export function quoteNonAsciiFromConfig({ config }: { config: GitConfig }): boolean {
  return getBooleanConfigValue({ config, key: 'core.quotepath' }) ?? true;
}
export function formatGitPatchPath({ path, prefix, quoteNonAscii, headerLabel }: {
  path: string,
  prefix: 'a' | 'b',
  quoteNonAscii: boolean,
  headerLabel: boolean,
}): string {
  const fullPath = `${prefix}/${path}`;
  const rendered = quoteGitPath({ path: fullPath, quoteNonAscii, quoteSpaces: false });
  if (!headerLabel || rendered.startsWith('"')) return rendered;
  return path.includes(' ') ? `${rendered}\t` : rendered;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
