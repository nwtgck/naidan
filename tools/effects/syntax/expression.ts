import type { Effect } from '../contracts/effects.ts';
import { mergeEffects, printEffect } from '../contracts/effects.ts';
import type { EffectDefinition } from '../models/registry.ts';
import { EffectSyntaxError } from './error.ts';
import { parseJsonPayload } from './json.ts';
import { effectRowSchema, parseEffectMetadata } from './schema.ts';

export { EffectSyntaxError } from './error.ts';

function identifierStart({ character }: { character: string | undefined }): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || character === '_';
}

function identifierContinue({ character }: { character: string | undefined }): boolean {
  return identifierStart({ character }) || character !== undefined && character >= '0' && character <= '9';
}

/** Parse exactly one operation or symbolic callback, never a union or source expression. */
export function parseEffectAtom({ text, definitions }: { text: string, definitions: readonly EffectDefinition[] }): Effect {
  if (text.length > 65_536) throw new EffectSyntaxError({ message: 'Effect atom is too long.', offset: 0 });
  const registry = new Map(definitions.map(definition => [definition.name, definition.arguments]));
  let position = 0;
  const fail = ({ message }: { message: string }): never => {
    throw new EffectSyntaxError({ message, offset: position });
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
      if (character === '\n' || character === '\r') fail({ message: 'Escape line breaks inside resource strings.' });
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
  const name = reference().join('.');
  if (name === 'none') fail({ message: 'Use [] for an empty effect row.' });
  let effect: Effect;
  if (name === 'call') {
    expect({ character: '(' });
    const path = reference();
    expect({ character: ')' });
    effect = { kind: 'callback', path };
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
      effect = { kind: 'operation', name, target };
      break;
    }
    case 'none': effect = { kind: 'operation', name, target: undefined }; break;
    case undefined: return fail({ message: `Unknown effect: ${name}.` });
    default: { const exhaustive: never = argumentKind; throw new Error(String(exhaustive)); }
    }
  }
  if (position !== text.length) fail({ message: 'Each effect row item must contain exactly one atom.' });
  return effect;
}

/** Shared by TypeScript comments, Vue event maps and reviewed model configuration. */
export function parseEffectRow({ value, definitions }: { value: unknown, definitions: readonly EffectDefinition[] }): Effect[] {
  const row = parseEffectMetadata({ schema: effectRowSchema, value });
  const effects = row.map((text, index) => {
    try {
      return parseEffectAtom({ text, definitions });
    } catch (error) {
      if (!(error instanceof EffectSyntaxError)) throw error;
      // Decoded atom offsets are not source offsets in the outer JSON payload.
      throw new EffectSyntaxError({ message: `Effect item ${index + 1}: ${error.message}`, offset: 0 });
    }
  });
  return mergeEffects({ groups: [effects] });
}

export function parseEffects({ text, definitions }: { text: string, definitions: readonly EffectDefinition[] }): Effect[] {
  return parseEffectRow({ value: parseJsonPayload({ text }), definitions });
}

export function effectRowValues({ effects }: { effects: readonly Effect[] }): string[] {
  return mergeEffects({ groups: [effects] }).map(effect => printEffect({ effect }));
}

export function printEffects({ effects }: { effects: readonly Effect[] }): string {
  // Escape at the outer JSON layer so decoded resource strings remain unchanged.
  return JSON.stringify(effectRowValues({ effects })).replaceAll('*/', '*\\u002f');
}
