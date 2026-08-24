type Quantifier = {
  readonly endIndex: number,
  readonly isVariable: boolean,
  readonly repeatsMoreThanOnce: boolean,
};

type Atom = {
  readonly containsAmbiguousAlternation: boolean,
  readonly containsVariableQuantifier: boolean,
  readonly kind: 'group' | 'simple',
};

type GroupFrame = {
  readonly contentStartIndex: number,
  containsAmbiguousAlternation: boolean,
  hasTopLevelAlternation: boolean,
  containsVariableQuantifier: boolean,
  lastAtom: Atom | undefined,
};

type LiteralPrefix = {
  readonly complete: boolean,
  readonly value: string,
};

function splitTopLevelAlternatives({ source }: { source: string }): readonly string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let startIndex = 0;
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') {
      index = consumeCharacterClass({ source, startIndex: index });
      continue;
    }
    if (character === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (character === '|' && depth === 0) {
      alternatives.push(source.slice(startIndex, index));
      startIndex = index + 1;
    }
    index += 1;
  }
  if (alternatives.length === 0) return [];
  alternatives.push(source.slice(startIndex));
  return alternatives;
}

function readLiteralPrefix({ source }: { source: string }): LiteralPrefix {
  let value = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '\\') {
      const escaped = source[index + 1];
      if (escaped === undefined || /[0-9A-Za-z]/.test(escaped)) {
        return { complete: false, value };
      }
      value += escaped;
      index += 2;
      continue;
    }
    if ('.^$*+?{[()|'.includes(character)) {
      return { complete: false, value };
    }
    value += character;
    index += 1;
  }
  return { complete: true, value };
}

function hasAmbiguousLiteralPrefixAlternation({ source }: { source: string }): boolean {
  const alternatives = splitTopLevelAlternatives({ source });
  if (alternatives.length < 2) return false;
  const prefixes = alternatives.map((alternative) => readLiteralPrefix({ source: alternative }));
  for (let leftIndex = 0; leftIndex < prefixes.length; leftIndex += 1) {
    const left = prefixes[leftIndex]!;
    if (!left.complete || left.value.length === 0) continue;
    for (let rightIndex = 0; rightIndex < prefixes.length; rightIndex += 1) {
      if (leftIndex === rightIndex) continue;
      const right = prefixes[rightIndex]!;
      if (right.value.startsWith(left.value)) return true;
    }
  }
  return false;
}

function consumeCharacterClass({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): number {
  let index = startIndex + 1;
  if (source[index] === '^') index += 1;
  if (source[index] === ']') index += 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === ']') return index + 1;
    index += 1;
  }
  return source.length;
}

function consumeGroupPrefix({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): number {
  if (source[startIndex + 1] !== '?') return startIndex + 1;
  const marker = source[startIndex + 2];
  if (marker === ':' || marker === '=' || marker === '!') return startIndex + 3;
  if (marker !== '<') return startIndex + 1;
  const lookbehindMarker = source[startIndex + 3];
  if (lookbehindMarker === '=' || lookbehindMarker === '!') return startIndex + 4;
  const nameEnd = source.indexOf('>', startIndex + 3);
  return nameEnd === -1 ? startIndex + 1 : nameEnd + 1;
}

function parseQuantifier({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): Quantifier | undefined {
  const first = source[startIndex];
  if (first === '*') {
    return { endIndex: startIndex + 1, isVariable: true, repeatsMoreThanOnce: true };
  }
  if (first === '+') {
    return { endIndex: startIndex + 1, isVariable: true, repeatsMoreThanOnce: true };
  }
  if (first === '?') {
    return { endIndex: startIndex + 1, isVariable: true, repeatsMoreThanOnce: false };
  }
  if (first !== '{') return undefined;

  let index = startIndex + 1;
  const minimumStart = index;
  while (/\d/.test(source[index] ?? '')) index += 1;
  if (index === minimumStart) return undefined;
  const minimum = Number(source.slice(minimumStart, index));
  if (source[index] === '}') {
    return {
      endIndex: index + 1,
      isVariable: false,
      repeatsMoreThanOnce: minimum > 1,
    };
  }
  if (source[index] !== ',') return undefined;
  index += 1;
  const maximumStart = index;
  while (/\d/.test(source[index] ?? '')) index += 1;
  if (source[index] !== '}') return undefined;
  const maximum = index === maximumStart
    ? Number.POSITIVE_INFINITY
    : Number(source.slice(maximumStart, index));
  return {
    endIndex: index + 1,
    isVariable: minimum !== maximum,
    repeatsMoreThanOnce: maximum > 1,
  };
}

export function hasPotentiallyUnsafeBacktrackingStructure({
  source,
}: {
  source: string,
}): boolean {
  const frames: GroupFrame[] = [{
    contentStartIndex: 0,
    containsAmbiguousAlternation: false,
    containsVariableQuantifier: false,
    hasTopLevelAlternation: false,
    lastAtom: undefined,
  }];
  let index = 0;
  while (index < source.length) {
    const frame = frames.at(-1)!;
    const character = source[index]!;
    if (character === '\\') {
      frame.lastAtom = {
        containsAmbiguousAlternation: false,
        containsVariableQuantifier: false,
        kind: 'simple',
      };
      index += Math.min(2, source.length - index);
      continue;
    }
    if (character === '[') {
      frame.lastAtom = {
        containsAmbiguousAlternation: false,
        containsVariableQuantifier: false,
        kind: 'simple',
      };
      index = consumeCharacterClass({ source, startIndex: index });
      continue;
    }
    if (character === '(') {
      const contentStartIndex = consumeGroupPrefix({ source, startIndex: index });
      frames.push({
        contentStartIndex,
        containsAmbiguousAlternation: false,
        containsVariableQuantifier: false,
        hasTopLevelAlternation: false,
        lastAtom: undefined,
      });
      index = contentStartIndex;
      continue;
    }
    if (character === ')' && frames.length > 1) {
      const completed = frames.pop()!;
      const containsAmbiguousAlternation = completed.containsAmbiguousAlternation
        || (
          completed.hasTopLevelAlternation
          && hasAmbiguousLiteralPrefixAlternation({
            source: source.slice(completed.contentStartIndex, index),
          })
        );
      const parent = frames.at(-1)!;
      parent.containsAmbiguousAlternation ||= containsAmbiguousAlternation;
      parent.containsVariableQuantifier ||= completed.containsVariableQuantifier;
      parent.lastAtom = {
        containsAmbiguousAlternation,
        containsVariableQuantifier: completed.containsVariableQuantifier,
        kind: 'group',
      };
      index += 1;
      continue;
    }
    const quantifier = parseQuantifier({ source, startIndex: index });
    if (quantifier !== undefined && frame.lastAtom !== undefined) {
      if (
        frame.lastAtom.kind === 'group'
        && (
          frame.lastAtom.containsVariableQuantifier
          || frame.lastAtom.containsAmbiguousAlternation
        )
        && quantifier.repeatsMoreThanOnce
      ) {
        return true;
      }
      frame.containsAmbiguousAlternation ||= frame.lastAtom.containsAmbiguousAlternation;
      frame.containsVariableQuantifier ||= quantifier.isVariable
        || frame.lastAtom.containsVariableQuantifier;
      index = quantifier.endIndex;
      if (source[index] === '?') index += 1;
      continue;
    }
    switch (character) {
    case '|':
      frame.hasTopLevelAlternation = true;
      frame.lastAtom = undefined;
      index += 1;
      continue;
    case '^':
    case '$':
      frame.lastAtom = undefined;
      index += 1;
      continue;
    default:
      break;
    }
    frame.lastAtom = {
      containsAmbiguousAlternation: false,
      containsVariableQuantifier: false,
      kind: 'simple',
    };
    index += 1;
  }
  return false;
}

export const UNSAFE_REGULAR_EXPRESSION_INPUT_LIMIT = 24;

export function exceedsSafeRegularExpressionInputLimit({
  regex,
  input,
}: {
  regex: RegExp;
  input: string;
}): boolean {
  return input.length > UNSAFE_REGULAR_EXPRESSION_INPUT_LIMIT
    && hasPotentiallyUnsafeBacktrackingStructure({ source: regex.source });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
