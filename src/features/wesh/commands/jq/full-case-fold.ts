const JQ_MAX_FULL_CASE_FOLD_ALTERNATIVES = 256;

type JqFullCaseFoldRenderingMode = "explicit" | "js-ignore-case";

const JQ_SIMPLE_CASE_FOLD_SPECIAL_GROUPS = [
  "KkK",
  "Ssſ",
  "µΜμ",
  "ÅåÅ",
  "ͅΙιι",
  "Ββϐ",
  "Εεϵ",
  "Θθϑϴ",
  "Κκϰ",
  "Ππϖ",
  "Ρρϱ",
  "Σςσ",
  "Φφϕ",
  "ΩωΩ",
  "Ввᲀ",
  "Ддᲁ",
  "Ооᲂ",
  "Ссᲃ",
  "Ттᲄᲅ",
  "Ъъᲆ",
  "Ѣѣᲇ",
  "ᲈꙊꙋ",
  "Ṡṡẛ",
] as const;

const JQ_BACKREFERENCE_CASE_FOLD_GROUPS = [
  "Kk",
  "K",
  "Ss",
  "ſ",
  "µΜμ",
  "Åå",
  "Å",
  "ͅΙι",
  "ι",
  "Ββϐ",
  "Εεϵ",
  "Θθϑϴ",
  "Κκϰ",
  "Ππϖ",
  "Ρρϱ",
  "Σςσ",
  "Φφϕ",
  "Ωω",
  "Ω",
  "Вв",
  "ᲀ",
  "Дд",
  "ᲁ",
  "Оо",
  "ᲂ",
  "Сс",
  "ᲃ",
  "Тт",
  "ᲄᲅ",
  "Ъъ",
  "ᲆ",
  "Ѣѣ",
  "ᲇ",
  "ᲈꙊꙋ",
  "Ṡṡẛ",
  "ß",
  "ẞ",
] as const;

const JQ_BACKREFERENCE_NONTERMINAL_CASE_FOLD_CHARACTERS_BY_TARGET = new Map<
  string,
  string
>([
  ["ſ", "Ssſ"],
  ["Å", "ÅåÅ"],
  ["ι", "ͅΙιι"],
  ["Ω", "ΩωΩ"],
  ["ᲀ", "Ввᲀ"],
  ["ᲁ", "Ддᲁ"],
  ["ᲂ", "Ооᲂ"],
  ["ᲃ", "Ссᲃ"],
  ["ᲄ", "Ттᲄᲅ"],
  ["ᲅ", "Ттᲄᲅ"],
  ["ᲆ", "Ъъᲆ"],
  ["ᲇ", "Ѣѣᲇ"],
  ["ẞ", "ßẞ"],
]);

const JQ_UNICODE_FULL_CASE_FOLDS = [
  { fold: "ss", characters: "ßẞ" },
  { fold: "i̇", characters: "İ" },
  { fold: "ʼn", characters: "ŉ" },
  { fold: "ǰ", characters: "ǰ" },
  { fold: "ΐ", characters: "ΐΐ" },
  { fold: "ΰ", characters: "ΰΰ" },
  { fold: "եւ", characters: "և" },
  { fold: "ẖ", characters: "ẖ" },
  { fold: "ẗ", characters: "ẗ" },
  { fold: "ẘ", characters: "ẘ" },
  { fold: "ẙ", characters: "ẙ" },
  { fold: "aʾ", characters: "ẚ" },
  { fold: "ὐ", characters: "ὐ" },
  { fold: "ὒ", characters: "ὒ" },
  { fold: "ὔ", characters: "ὔ" },
  { fold: "ὖ", characters: "ὖ" },
  { fold: "ἀι", characters: "ᾀᾈ" },
  { fold: "ἁι", characters: "ᾁᾉ" },
  { fold: "ἂι", characters: "ᾂᾊ" },
  { fold: "ἃι", characters: "ᾃᾋ" },
  { fold: "ἄι", characters: "ᾄᾌ" },
  { fold: "ἅι", characters: "ᾅᾍ" },
  { fold: "ἆι", characters: "ᾆᾎ" },
  { fold: "ἇι", characters: "ᾇᾏ" },
  { fold: "ἠι", characters: "ᾐᾘ" },
  { fold: "ἡι", characters: "ᾑᾙ" },
  { fold: "ἢι", characters: "ᾒᾚ" },
  { fold: "ἣι", characters: "ᾓᾛ" },
  { fold: "ἤι", characters: "ᾔᾜ" },
  { fold: "ἥι", characters: "ᾕᾝ" },
  { fold: "ἦι", characters: "ᾖᾞ" },
  { fold: "ἧι", characters: "ᾗᾟ" },
  { fold: "ὠι", characters: "ᾠᾨ" },
  { fold: "ὡι", characters: "ᾡᾩ" },
  { fold: "ὢι", characters: "ᾢᾪ" },
  { fold: "ὣι", characters: "ᾣᾫ" },
  { fold: "ὤι", characters: "ᾤᾬ" },
  { fold: "ὥι", characters: "ᾥᾭ" },
  { fold: "ὦι", characters: "ᾦᾮ" },
  { fold: "ὧι", characters: "ᾧᾯ" },
  { fold: "ὰι", characters: "ᾲ" },
  { fold: "αι", characters: "ᾳᾼ" },
  { fold: "άι", characters: "ᾴ" },
  { fold: "ᾶ", characters: "ᾶ" },
  { fold: "ᾶι", characters: "ᾷ" },
  { fold: "ὴι", characters: "ῂ" },
  { fold: "ηι", characters: "ῃῌ" },
  { fold: "ήι", characters: "ῄ" },
  { fold: "ῆ", characters: "ῆ" },
  { fold: "ῆι", characters: "ῇ" },
  { fold: "ῒ", characters: "ῒ" },
  { fold: "ῖ", characters: "ῖ" },
  { fold: "ῗ", characters: "ῗ" },
  { fold: "ῢ", characters: "ῢ" },
  { fold: "ῤ", characters: "ῤ" },
  { fold: "ῦ", characters: "ῦ" },
  { fold: "ῧ", characters: "ῧ" },
  { fold: "ὼι", characters: "ῲ" },
  { fold: "ωι", characters: "ῳῼ" },
  { fold: "ώι", characters: "ῴ" },
  { fold: "ῶ", characters: "ῶ" },
  { fold: "ῶι", characters: "ῷ" },
  { fold: "ff", characters: "ﬀ" },
  { fold: "fi", characters: "ﬁ" },
  { fold: "fl", characters: "ﬂ" },
  { fold: "ffi", characters: "ﬃ" },
  { fold: "ffl", characters: "ﬄ" },
  { fold: "st", characters: "ﬅﬆ" },
  { fold: "մն", characters: "ﬓ" },
  { fold: "մե", characters: "ﬔ" },
  { fold: "մի", characters: "ﬕ" },
  { fold: "վն", characters: "ﬖ" },
  { fold: "մխ", characters: "ﬗ" },
] as const;

type JqUnicodeFullCaseFold = {
  readonly fold: string;
  readonly representative: string;
  readonly foldCodePoints: readonly string[];
};

const JQ_FULL_CASE_FOLD_BY_CHARACTER = new Map<string, string>();
const JQ_FULL_CASE_FOLD_CHARACTERS_BY_CHARACTER = new Map<string, string>();
const JQ_SIMPLE_CASE_FOLD_SPECIAL_GROUP_BY_CHARACTER = new Map<string, string>();
const JQ_BACKREFERENCE_CASE_FOLD_GROUP_BY_CHARACTER = new Map<string, string>();
const JQ_FULL_CASE_FOLDS_BY_FIRST_CODE_POINT = new Map<
  string,
  JqUnicodeFullCaseFold[]
>();

for (const { fold, characters } of JQ_UNICODE_FULL_CASE_FOLDS) {
  for (const character of characters) {
    JQ_FULL_CASE_FOLD_BY_CHARACTER.set(character, fold);
    JQ_FULL_CASE_FOLD_CHARACTERS_BY_CHARACTER.set(character, characters);
  }
  const foldCodePoints = [...fold];
  const first = foldCodePoints[0]!;
  const entries = JQ_FULL_CASE_FOLDS_BY_FIRST_CODE_POINT.get(first) ?? [];
  entries.push({
    fold,
    representative: [...characters][0]!,
    foldCodePoints,
  });
  JQ_FULL_CASE_FOLDS_BY_FIRST_CODE_POINT.set(first, entries);
}


for (const group of JQ_SIMPLE_CASE_FOLD_SPECIAL_GROUPS) {
  for (const character of group) {
    JQ_SIMPLE_CASE_FOLD_SPECIAL_GROUP_BY_CHARACTER.set(character, group);
  }
}

for (const group of JQ_BACKREFERENCE_CASE_FOLD_GROUPS) {
  for (const character of group) {
    JQ_BACKREFERENCE_CASE_FOLD_GROUP_BY_CHARACTER.set(character, group);
  }
}

for (const entries of JQ_FULL_CASE_FOLDS_BY_FIRST_CODE_POINT.values()) {
  entries.sort((left, right) =>
    right.foldCodePoints.length - left.foldCodePoints.length,
  );
}

function escapeJqRegularExpressionLiteral({
  value,
}: {
  value: string;
}): string {
  return [...value]
    .map((character) =>
      /[\\^$.*+?()[\]{}|]/u.test(character)
        ? `\\${character}`
        : character,
    )
    .join("");
}

const JQ_BACKREFERENCE_CASE_FOLD_REGEXP_CACHE = new Map<string, RegExp>();

export function jqCaseInsensitiveBackreferenceCharactersEqual({
  left,
  right,
  hasInputSuffix,
}: {
  left: string;
  right: string;
  hasInputSuffix: boolean;
}): boolean {
  const nonterminalCharacters = hasInputSuffix
    ? JQ_BACKREFERENCE_NONTERMINAL_CASE_FOLD_CHARACTERS_BY_TARGET.get(left)
    : undefined;
  if (nonterminalCharacters !== undefined) {
    return nonterminalCharacters.includes(right);
  }

  const leftGroup = JQ_BACKREFERENCE_CASE_FOLD_GROUP_BY_CHARACTER.get(left);
  const rightGroup = JQ_BACKREFERENCE_CASE_FOLD_GROUP_BY_CHARACTER.get(right);
  if (leftGroup !== undefined || rightGroup !== undefined) {
    return leftGroup !== undefined && leftGroup === rightGroup;
  }

  let regex = JQ_BACKREFERENCE_CASE_FOLD_REGEXP_CACHE.get(left);
  if (regex === undefined) {
    regex = new RegExp(
      `^(?:${escapeJqRegularExpressionLiteral({ value: left })})$`,
      "iu",
    );
    JQ_BACKREFERENCE_CASE_FOLD_REGEXP_CACHE.set(left, regex);
  }
  return regex.test(right);
}

const JQ_SIMPLE_CASE_FOLD_CACHE = new Map<string, string>();
const JQ_EXPLICIT_SIMPLE_CASE_CHARACTERS_CACHE = new Map<
  string,
  readonly string[]
>();

function jqSimpleCaseFoldCharacter({
  character,
}: {
  character: string;
}): string {
  const fullFold = JQ_FULL_CASE_FOLD_BY_CHARACTER.get(character);
  if (fullFold !== undefined) return fullFold;
  const cached = JQ_SIMPLE_CASE_FOLD_CACHE.get(character);
  if (cached !== undefined) return cached;

  const upper = character.toUpperCase();
  const candidate = [...upper].length === 1
    ? upper.toLowerCase()
    : character.toLowerCase();
  const fold =
    [...candidate].length === 1 &&
    new RegExp(
      escapeJqRegularExpressionLiteral({ value: character }),
      "iu",
    ).test(candidate)
      ? candidate
      : character;
  JQ_SIMPLE_CASE_FOLD_CACHE.set(character, fold);
  return fold;
}

function jqExplicitSimpleCaseCharacters({
  character,
}: {
  character: string;
}): readonly string[] {
  const special = JQ_SIMPLE_CASE_FOLD_SPECIAL_GROUP_BY_CHARACTER.get(character);
  if (special !== undefined) return [...special];
  const cached = JQ_EXPLICIT_SIMPLE_CASE_CHARACTERS_CACHE.get(character);
  if (cached !== undefined) return cached;

  const candidates = new Set([character]);
  for (const variant of [
    character.toUpperCase(),
    character.toLowerCase(),
    character.toLocaleUpperCase("und"),
    character.toLocaleLowerCase("und"),
  ]) {
    if (
      [...variant].length === 1 &&
      new RegExp(
        escapeJqRegularExpressionLiteral({ value: character }),
        "iu",
      ).test(variant)
    ) {
      candidates.add(variant);
    }
  }
  const result = [...candidates];
  JQ_EXPLICIT_SIMPLE_CASE_CHARACTERS_CACHE.set(character, result);
  return result;
}

function jqCanonicalCaseFold({ value }: { value: string }): string {
  return [...value]
    .map((character) => jqSimpleCaseFoldCharacter({ character }))
    .join("");
}

function escapeJqExplicitCharacterClassLiteral({
  character,
}: {
  character: string;
}): string {
  return /^[\\\]\-^]$/u.test(character) ? `\\${character}` : character;
}

function renderExplicitCharacterSet({
  characters,
}: {
  characters: readonly string[];
}): string {
  const unique = [...new Set(characters)];
  if (unique.length === 1) {
    return escapeJqRegularExpressionLiteral({ value: unique[0]! });
  }
  return `[${unique
    .map((character) => escapeJqExplicitCharacterClassLiteral({ character }))
    .join("")}]`;
}

export function renderJqExplicitSimpleCaseFoldAtom({
  character,
}: {
  character: string;
}): string {
  return renderExplicitCharacterSet({
    characters: jqExplicitSimpleCaseCharacters({ character }),
  });
}

export function jqSimpleCaseFoldCharactersHaveEquivalentBackreferenceSemantics({
  character,
}: {
  character: string;
}): boolean {
  return jqExplicitSimpleCaseCharacters({ character }).every(
    candidate =>
      jqCaseInsensitiveBackreferenceCharactersEqual({
        left: character,
        right: candidate,
        hasInputSuffix: false,
      }) &&
      jqCaseInsensitiveBackreferenceCharactersEqual({
        left: character,
        right: candidate,
        hasInputSuffix: true,
      }),
  );
}

export function renderJqExplicitCaseFoldClassContent({
  character,
}: {
  character: string;
}): string {
  const fullCharacters = JQ_FULL_CASE_FOLD_CHARACTERS_BY_CHARACTER.get(
    character,
  );
  const characters = fullCharacters === undefined
    ? jqExplicitSimpleCaseCharacters({ character })
    : [...fullCharacters];
  return [...new Set(characters)]
    .map((candidate) =>
      escapeJqExplicitCharacterClassLiteral({ character: candidate }),
    )
    .join("");
}

export function renderJqExplicitFullCaseFoldAlternative({
  character,
}: {
  character: string;
}): string | undefined {
  if (!JQ_FULL_CASE_FOLD_BY_CHARACTER.has(character)) return undefined;
  return translateJqUnicodeFullCaseFoldLiteral({
    literal: character,
    mode: "explicit",
  });
}

function renderJqFullFoldCharacterAtom({
  character,
  mode,
}: {
  character: string;
  mode: JqFullCaseFoldRenderingMode;
}): string {
  switch (mode) {
  case "js-ignore-case":
    return escapeJqRegularExpressionLiteral({ value: character });
  case "explicit":
    return renderExplicitCharacterSet({
      characters: [
        ...(JQ_FULL_CASE_FOLD_CHARACTERS_BY_CHARACTER.get(character) ??
          character),
      ],
    });
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled full case-fold rendering mode: ${_ex}`);
  }
  }
}

function renderJqCanonicalCharacterAtom({
  character,
  mode,
}: {
  character: string;
  mode: JqFullCaseFoldRenderingMode;
}): string {
  switch (mode) {
  case "js-ignore-case":
    return escapeJqRegularExpressionLiteral({ value: character });
  case "explicit":
    return renderJqExplicitSimpleCaseFoldAtom({ character });
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled full case-fold rendering mode: ${_ex}`);
  }
  }
}

function renderJqLiteralOriginalAlternative({
  literal,
  mode,
}: {
  literal: string;
  mode: JqFullCaseFoldRenderingMode;
}): string {
  switch (mode) {
  case "js-ignore-case":
    return escapeJqRegularExpressionLiteral({ value: literal });
  case "explicit":
    return [...literal]
      .map((character) =>
        JQ_FULL_CASE_FOLD_BY_CHARACTER.has(character)
          ? renderJqFullFoldCharacterAtom({ character, mode })
          : renderJqExplicitSimpleCaseFoldAtom({ character }),
      )
      .join("");
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled full case-fold rendering mode: ${_ex}`);
  }
  }
}

function foldEntryMatches({
  codePoints,
  startIndex,
  entry,
}: {
  codePoints: readonly string[];
  startIndex: number;
  entry: JqUnicodeFullCaseFold;
}): boolean {
  if (startIndex + entry.foldCodePoints.length > codePoints.length) return false;
  for (let index = 0; index < entry.foldCodePoints.length; index += 1) {
    if (codePoints[startIndex + index] !== entry.foldCodePoints[index]) return false;
  }
  return true;
}

function rejectUnsafeJqLiteralFullCaseFoldExpansion({
  literal,
  mode,
}: {
  literal: string;
  mode: JqFullCaseFoldRenderingMode;
}): never {
  throw new Error(
    `full Unicode case-fold expansion exceeds the safe limit ` +
      `(${[...literal].length} code points, ${mode})`,
  );
}

export function translateJqUnicodeFullCaseFoldLiteral({
  literal,
  mode,
}: {
  literal: string;
  mode: JqFullCaseFoldRenderingMode;
}): string {
  if (literal.length === 0) return "";
  const canonical = jqCanonicalCaseFold({ value: literal });
  const codePoints = [...canonical];
  const paths: string[][] = Array.from(
    { length: codePoints.length + 1 },
    () => [],
  );
  paths[0]!.push("");
  let alternativeCount = 1;

  for (let index = 0; index < codePoints.length; index += 1) {
    const prefixes = paths[index]!;
    if (prefixes.length === 0) continue;
    const ordinary = renderJqCanonicalCharacterAtom({
      character: codePoints[index]!,
      mode,
    });
    for (const prefix of prefixes) paths[index + 1]!.push(prefix + ordinary);

    const entries = JQ_FULL_CASE_FOLDS_BY_FIRST_CODE_POINT.get(
      codePoints[index]!,
    ) ?? [];
    for (const entry of entries) {
      if (!foldEntryMatches({ codePoints, startIndex: index, entry })) continue;
      const destination = paths[index + entry.foldCodePoints.length]!;
      const replacement = renderJqFullFoldCharacterAtom({
        character: entry.representative,
        mode,
      });
      for (const prefix of prefixes) {
        destination.push(prefix + replacement);
        alternativeCount += 1;
        if (alternativeCount > JQ_MAX_FULL_CASE_FOLD_ALTERNATIVES) {
          return rejectUnsafeJqLiteralFullCaseFoldExpansion({ literal, mode });
        }
      }
    }
  }

  const original = renderJqLiteralOriginalAlternative({ literal, mode });
  const alternatives = [original, ...paths.at(-1)!];
  const unique = [...new Set(alternatives)];
  if (unique.length === 1) return unique[0]!;
  return `(?:${unique.join("|")})`;
}

function findJqCaseFoldEscapeEnd({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number {
  const marker = source[startIndex + 1];
  if (marker === undefined) return startIndex + 1;
  const opening = source[startIndex + 2];
  if (
    (marker === "g" || marker === "k") &&
    (opening === "<" || opening === "'")
  ) {
    const closing = (() => {
      switch (opening) {
      case "<":
        return ">";
      case "'":
        return "'";
      default: {
        const _ex: never = opening;
        throw new Error(`Unhandled jq reference delimiter: ${_ex}`);
      }
      }
    })();
    const end = source.indexOf(closing, startIndex + 3);
    return end === -1 ? source.length : end + 1;
  }
  if (
    (marker === "p" || marker === "P" || marker === "u" ||
      marker === "x" || marker === "o") &&
    opening === "{"
  ) {
    const end = source.indexOf("}", startIndex + 3);
    return end === -1 ? source.length : end + 1;
  }
  if (marker === "u") return Math.min(source.length, startIndex + 6);
  return Math.min(source.length, startIndex + 2);
}

function findJqCaseFoldCharacterClassEnd({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number {
  let index = startIndex + 1;
  if (source[index] === "^") index += 1;
  if (source[index] === "]") index += 1;
  for (; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index = findJqCaseFoldEscapeEnd({ source, startIndex: index }) - 1;
      continue;
    }
    if (source[index] === "]") return index;
  }
  return source.length - 1;
}

function translateJqPositiveCharacterClassFullCaseFolds({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): { readonly source: string; readonly endIndex: number } {
  const endIndex = findJqCaseFoldCharacterClassEnd({ source, startIndex });
  const original = source.slice(startIndex, endIndex + 1);
  if (source[startIndex + 1] === "^") return { source: original, endIndex };

  const foldAlternatives: string[] = [];
  let index = startIndex + 1;
  if (source[index] === "]") index += 1;
  while (index < endIndex) {
    if (source[index] === "\\") {
      index = findJqCaseFoldEscapeEnd({ source, startIndex: index });
      continue;
    }
    const character = String.fromCodePoint(source.codePointAt(index)!);
    const nextIndex = index + character.length;
    const inRange = source[index - 1] === "-" || source[nextIndex] === "-";
    if (!inRange) {
      const fold = JQ_FULL_CASE_FOLD_BY_CHARACTER.get(character);
      if (fold !== undefined) {
        foldAlternatives.push(
          escapeJqRegularExpressionLiteral({ value: fold }),
        );
      }
    }
    index = nextIndex;
  }

  const unique = [...new Set(foldAlternatives)];
  return {
    source: unique.length === 0
      ? original
      : `(?:${original}|${unique.join("|")})`,
    endIndex,
  };
}

function findJqCaseFoldQuantifierEnd({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number | undefined {
  const marker = source[startIndex];
  let endIndex: number;
  if (marker === "*" || marker === "+" || marker === "?") {
    endIndex = startIndex + 1;
  } else if (marker === "{") {
    const match = /^\{\d+(?:,\d*)?\}/u.exec(source.slice(startIndex));
    if (match === null) return undefined;
    endIndex = startIndex + match[0].length;
  } else {
    return undefined;
  }
  if (source[endIndex] === "?" || source[endIndex] === "+") endIndex += 1;
  return endIndex;
}

function consumeJqCaseFoldGroupPrefix({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number {
  if (source[startIndex] !== "(" || source[startIndex + 1] !== "?") {
    return startIndex + 1;
  }
  if (
    source.startsWith("(?:", startIndex) ||
    source.startsWith("(?=", startIndex) ||
    source.startsWith("(?!", startIndex) ||
    source.startsWith("(?>", startIndex)
  ) return startIndex + 3;
  if (source.startsWith("(?<=", startIndex) || source.startsWith("(?<!", startIndex)) {
    return startIndex + 4;
  }
  if (source.startsWith("(?<", startIndex)) {
    const marker = source[startIndex + 3];
    if (marker === "=" || marker === "!") return startIndex + 4;
    const end = source.indexOf(">", startIndex + 3);
    return end === -1 ? source.length : end + 1;
  }
  let index = startIndex + 2;
  while (index < source.length && ![":", ")"].includes(source[index]!)) {
    index += 1;
  }
  return Math.min(source.length, index + 1);
}

export function translateJqUnicodeFullCaseFolds({
  source,
}: {
  source: string;
}): string {
  const parts: string[] = [];
  let literalRun = "";
  const flushLiteralRun = (): void => {
    if (literalRun.length === 0) return;
    parts.push(
      translateJqUnicodeFullCaseFoldLiteral({
        literal: literalRun,
        mode: "js-ignore-case",
      }),
    );
    literalRun = "";
  };

  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (character === "\\") {
      flushLiteralRun();
      const endIndex = findJqCaseFoldEscapeEnd({ source, startIndex: index });
      parts.push(source.slice(index, endIndex));
      index = endIndex;
      continue;
    }
    if (character === "[") {
      flushLiteralRun();
      const translated = translateJqPositiveCharacterClassFullCaseFolds({
        source,
        startIndex: index,
      });
      parts.push(translated.source);
      index = translated.endIndex + 1;
      continue;
    }
    if (character === "(") {
      flushLiteralRun();
      const endIndex = consumeJqCaseFoldGroupPrefix({ source, startIndex: index });
      parts.push(source.slice(index, endIndex));
      index = endIndex;
      continue;
    }
    if (/[)^$.*+?{}|]/u.test(character)) {
      flushLiteralRun();
      parts.push(character);
      index += 1;
      continue;
    }

    const literal = String.fromCodePoint(source.codePointAt(index)!);
    const nextIndex = index + literal.length;
    const quantifierEnd = findJqCaseFoldQuantifierEnd({
      source,
      startIndex: nextIndex,
    });
    if (quantifierEnd !== undefined) {
      flushLiteralRun();
      parts.push(
        translateJqUnicodeFullCaseFoldLiteral({
          literal,
          mode: "js-ignore-case",
        }),
        source.slice(nextIndex, quantifierEnd),
      );
      index = quantifierEnd;
      continue;
    }
    literalRun += literal;
    index = nextIndex;
  }
  flushLiteralRun();
  return parts.join("");
}

export const TEST_ONLY = {
  translateJqUnicodeFullCaseFolds,
};
