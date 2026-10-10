import type { Effect } from '../contracts/effects.ts';
import { mergeEffects, printEffect } from '../contracts/effects.ts';
import type { EffectDefinition } from '../models/registry.ts';

export class EffectSyntaxError extends Error {
  readonly offset: number;

  constructor({ message, offset }: { message: string, offset: number }) {
    super(message);
    this.name = 'EffectSyntaxError';
    this.offset = offset;
  }
}

function identifierStart({ character }: { character: string | undefined }): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || character === '_';
}

function identifierContinue({ character }: { character: string | undefined }): boolean {
  return identifierStart({ character }) || character !== undefined && character >= '0' && character <= '9';
}

/** A bounded recursive-descent grammar. It never evaluates source expressions. */
export function parseEffectPrefix({ text, definitions, terminator }: { text: string, definitions: readonly EffectDefinition[], terminator: '--' | undefined }): { effects: Effect[], end: number } {
  if (text.length > 65_536) throw new EffectSyntaxError({ message: 'Effect declaration is too long.', offset: 0 });
  const registry = new Map(definitions.map(definition => [definition.name, definition.arguments]));
  let position = 0;
  const terms: Effect[] = [];
  let hasNone = false;
  let separator: ',' | '&' | undefined;
  const fail = ({ message }: { message: string }): never => {
    throw new EffectSyntaxError({ message, offset: position });
  };
  const whitespace = () => {
    while (' \t\r\n'.includes(text[position] ?? '\0')) position++;
  };
  const expect = ({ character }: { character: string }) => {
    if (text[position] !== character) fail({ message: `Expected ${JSON.stringify(character)}.` });
    position++;
  };
  const reference = (): string[] => {
    const parts: string[] = [];
    do {
      if (parts.length > 0) position++;
      if (!identifierStart({ character: text[position] })) fail({ message: 'Expected an identifier.' });
      const start = position++;
      while (identifierContinue({ character: text[position] })) position++;
      parts.push(text.slice(start, position));
      if (parts.length > 32) fail({ message: 'Reference is too deep.' });
    } while (text[position] === '.');
    return parts;
  };
  const quoted = (): string => {
    const start = position;
    expect({ character: '"' });
    let escaped = false;
    for (; position < text.length; position++) {
      const character = text[position]!;
      if (character === '\n' || character === '\r' || character === '`') fail({ message: 'Escape line breaks and backticks inside resource strings.' });
      if (!escaped && character === '"') {
        position++;
        try {
          const value: unknown = JSON.parse(text.slice(start, position));
          if (typeof value !== 'string') return fail({ message: 'Expected a JSON string.' });
          return value;
        } catch {
          return fail({ message: 'Invalid string escape.' });
        }
      }
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
    }
    return fail({ message: 'Unterminated string.' });
  };
  whitespace();
  if (position === text.length) fail({ message: 'Use `none` for an empty effect row.' });
  while (position < text.length) {
    expect({ character: '`' });
    const parts = reference();
    const name = parts.join('.');
    if (name === 'none') {
      hasNone = true;
    } else if (name === 'call') {
      expect({ character: '(' });
      const path = reference();
      expect({ character: ')' });
      terms.push({ kind: 'callback', path });
    } else {
      const argumentKind = registry.get(name);
      if (argumentKind === undefined) fail({ message: `Unknown effect: ${name}.` });
      switch (argumentKind) {
      case 'resource': {
        expect({ character: '(' });
        const target = text[position] === '*'
          ? (position++, { kind: 'all' as const })
          : { kind: 'literal' as const, value: quoted() };
        expect({ character: ')' });
        terms.push({ kind: 'operation', name, target });
        break;
      }
      case 'none': terms.push({ kind: 'operation', name, target: undefined }); break;
      case undefined: return fail({ message: `Unknown effect: ${name}.` });
      default: { const exhaustive: never = argumentKind; throw new Error(String(exhaustive)); }
      }
    }
    expect({ character: '`' });
    whitespace();
    if (position === text.length || terminator !== undefined && text.startsWith(terminator, position)) break;
    const next = text[position];
    if (next !== ',' && next !== '&') fail({ message: 'Expected a comma or an ampersand between effect spans.' });
    if (separator !== undefined && separator !== next) fail({ message: 'Do not mix effect separators.' });
    separator = next as ',' | '&';
    position++;
    whitespace();
    if (position === text.length) fail({ message: 'Trailing separators are not permitted.' });
    if (hasNone) fail({ message: '`none` must be the only item.' });
  }
  if (hasNone && terms.length > 0) fail({ message: '`none` must be the only item.' });
  return { effects: mergeEffects({ groups: [terms] }), end: position };
}

export function parseEffects({ text, definitions }: { text: string, definitions: readonly EffectDefinition[] }): Effect[] {
  return parseEffectPrefix({ text, definitions, terminator: undefined }).effects;
}

export function printEffects({ effects }: { effects: readonly Effect[] }): string {
  const atoms = mergeEffects({ groups: [effects] });
  if (atoms.length === 0) return '`none`';
  return atoms.map(effect => {
    // Escape comment delimiters and code-span delimiters in JSON resource strings.
    const text = printEffect({ effect }).replaceAll('*/', '*\\u002f').replaceAll('`', '\\u0060');
    return '`' + text + '`';
  }).join(', ');
}
