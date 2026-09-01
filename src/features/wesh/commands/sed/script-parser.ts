import type { WeshCharacterLocaleMode } from "@/features/wesh/commands/_shared/locale";
import {
  parseSedQuitStatus,
  parseSedScriptListWidth,
  parseSedUnsigned64Decimal,
} from "./numeric-semantics";
import {
  applySedRegexModifiers,
  parseRegexLiteral,
  readSedRegexOperand,
  resolveSedRegex,
  type SedRegexParseState,
  type SedRegularExpressionSyntax,
} from "./regexp";
import { decodeSedExtendedEscape } from "./escape";
import { isSingleByteSedDelimiter, toSedLocaleText } from "./locale-text";
import { maximumSedReplacementBackreference } from "./replacement";
import { isZeroSedAddress, type SedAddress, type SedCommand } from "./command-model";

type SedParseState = SedRegexParseState;

type SedSubstituteCommand = Extract<SedCommand, { kind: "substitute" }>;

interface SedCompileEffects {
  readonly writePaths: string[];
}

type SedScriptParseResult =
  | { ok: true; commands: SedCommand[] }
  | { ok: false; message: string; deferUntilFinalSource?: true };

function parseLineNumberAddress({
  value,
}: {
  value: string;
}): SedAddress | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const lineNumber = parseSedUnsigned64Decimal({ value });
  if (lineNumber === 0n) {
    return { kind: "zero" };
  }
  return {
    kind: "line",
    lineNumber,
  };
}

function parseAddress({
  script,
  index,
  state,
  allowRelative,
}: {
  script: string;
  index: number;
  state: SedParseState;
  allowRelative: boolean;
}):
  | { ok: true; address: SedAddress | undefined; nextIndex: number }
  | { ok: false; message: string } {
  if (script[index] === "$") {
    return {
      ok: true,
      address: { kind: "last" },
      nextIndex: index + 1,
    };
  }

  const stepMatch = script.slice(index).match(/^(\d+)~(\d*)/u);
  if (stepMatch?.[1] !== undefined) {
    const first = parseSedUnsigned64Decimal({ value: stepMatch[1] });
    const stepText = stepMatch[2] ?? "";
    const step = stepText.length === 0 ? 0n : parseSedUnsigned64Decimal({ value: stepText });
    return {
      ok: true,
      address: { kind: "lineStep", first, step },
      nextIndex: index + stepMatch[0].length,
    };
  }

  if (allowRelative && (script[index] === "+" || script[index] === "~")) {
    const operator = script[index];
    let countIndex = index + 1;
    while (script[countIndex] === " " || script[countIndex] === "\t") {
      countIndex += 1;
    }
    const countMatch = script.slice(countIndex).match(/^\d+/u);
    const countText = countMatch?.[0] ?? "";
    const count = countText.length === 0 ? 0n : parseSedUnsigned64Decimal({ value: countText });
    return {
      ok: true,
      address: (() => {
        switch (operator) {
        case "+":
          return { kind: "relativeOffset" as const, count };
        case "~":
          return { kind: "relativeModulo" as const, modulus: count };
        default: {
          const _ex: never = operator;
          throw new Error(`Unhandled sed relative address operator: ${_ex}`);
        }
        }
      })(),
      nextIndex: countIndex + countText.length,
    };
  }

  const lineMatch = script.slice(index).match(/^\d+/);
  if (lineMatch?.[0] !== undefined) {
    return {
      ok: true,
      address: parseLineNumberAddress({ value: lineMatch[0] }),
      nextIndex: index + lineMatch[0].length,
    };
  }

  if (script[index] === "/" || script[index] === "\\") {
    const parsed = parseRegexLiteral({ script, index, state });
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      address: { kind: "regex", regex: parsed.regex },
      nextIndex: parsed.nextIndex,
    };
  }

  return {
    ok: true,
    address: undefined,
    nextIndex: index,
  };
}

function parseSubstituteCommand({
  script,
  index,
  address,
  rangeEnd,
  negated,
  state,
}: {
  script: string;
  index: number;
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
  state: SedParseState;
}):
  | { ok: true; command: SedSubstituteCommand; nextIndex: number }
  | { ok: false; message: string } {
  const delimiter = script[index + 1];
  if (delimiter === undefined) {
    return { ok: false, message: "unterminated substitute command" };
  }
  if (!isSingleByteSedDelimiter({ delimiter })) {
    return {
      ok: false,
      message: "delimiter character is not a single-byte character",
    };
  }

  const patternOperand = readSedRegexOperand({
    script,
    index: index + 2,
    delimiter,
    unterminatedMessage: "unterminated substitute command",
    sourceBoundaryIndices: state.sourceBoundaryIndices,
  });
  if (!patternOperand.ok) return patternOperand;

  let cursor = patternOperand.nextIndex;
  const pattern = patternOperand.source;
  let replacement = "";
  let escaped = false;

  escaped = false;
  let replacementTerminated = false;
  while (cursor < script.length) {
    if (state.sourceBoundaryIndices.has(cursor)) {
      return { ok: false, message: "unterminated substitute command" };
    }
    const char = script[cursor];
    if (char === undefined) break;
    if (!escaped && char === "\n") {
      return { ok: false, message: "unterminated substitute command" };
    }
    if (!escaped && char === delimiter) {
      replacementTerminated = true;
      cursor += 1;
      break;
    }
    replacement += char;
    escaped = !escaped && char === "\\";
    cursor += 1;
  }

  if (!replacementTerminated) {
    return { ok: false, message: "unterminated substitute command" };
  }

  let replaceFollowing = false;
  let sawGlobal = false;
  let occurrence = 1;
  let execute = false;
  let printPhase: "none" | "afterSubstitution" | "afterExecution" = "none";
  let sawPrint = false;
  let ignoreCase = false;
  let multiline = false;
  let writePath: string | undefined;
  let sawOccurrence = false;
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined) break;
    if (char === "g") {
      if (sawGlobal) {
        return { ok: false, message: "multiple 'g' options to 's' command" };
      }
      replaceFollowing = true;
      sawGlobal = true;
      cursor += 1;
      continue;
    }
    if (char === "e") {
      execute = true;
      cursor += 1;
      continue;
    }
    if (char === "p") {
      if (sawPrint) {
        return { ok: false, message: "multiple 'p' options to 's' command" };
      }
      printPhase = execute ? "afterExecution" : "afterSubstitution";
      sawPrint = true;
      cursor += 1;
      continue;
    }
    if (char === "I" || char === "i") {
      ignoreCase = true;
      cursor += 1;
      continue;
    }
    if (char === "M" || char === "m") {
      multiline = true;
      cursor += 1;
      continue;
    }
    if (char === "w") {
      const parsed = parseSedFileOperand({
        script,
        index: cursor + 1,
        command: "w",
      });
      if (!parsed.ok) return parsed;
      writePath = parsed.path;
      cursor = parsed.nextIndex;
      break;
    }
    if (/^\d$/.test(char)) {
      if (sawOccurrence) {
        return { ok: false, message: "multiple number options to s command" };
      }
      const numberMatch = script.slice(cursor).match(/^\d+/);
      if (numberMatch?.[0] === undefined) {
        return { ok: false, message: "invalid substitute occurrence" };
      }
      const parsedOccurrence = parseSedUnsigned64Decimal({ value: numberMatch[0] });
      if (parsedOccurrence === 0n) {
        return { ok: false, message: "invalid substitute occurrence" };
      }
      occurrence =
        parsedOccurrence <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(parsedOccurrence)
          : Number.POSITIVE_INFINITY;
      sawOccurrence = true;
      cursor += numberMatch[0].length;
      continue;
    }
    break;
  }

  if (script[cursor] === "\r" && script[cursor + 1] === "\n") {
    cursor += 1;
  }

  if (pattern.length === 0 && (ignoreCase || multiline)) {
    return { ok: false, message: "cannot specify modifiers on empty regexp" };
  }

  try {
    const regex = applySedRegexModifiers({
      regex: resolveSedRegex({
        source: pattern,
        state,
        global: true,
        dotMatchesNewline: !multiline,
      }),
      ignoreCase,
      multiline,
      state,
    });
    const maximumBackreference = maximumSedReplacementBackreference({
      replacement,
    });
    if (maximumBackreference > state.previousCaptureCount) {
      return {
        ok: false,
        message: `invalid reference \\${maximumBackreference} on 's' command's RHS`,
      };
    }
    return {
      ok: true,
      command: {
        kind: "substitute",
        address,
        rangeEnd,
        negated,
        regex,
        replacement,
        occurrence,
        replaceFollowing,
        execute,
        printPhase,
        writePath,
      },
      nextIndex: cursor,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `invalid substitute regex '${pattern}': ${message}`,
    };
  }
}

function parseDelimitedSedText({
  script,
  index,
  label,
  sourceBoundaryIndices,
}: {
  script: string;
  index: number;
  label: string;
  sourceBoundaryIndices: ReadonlySet<number>;
}):
  | { ok: true; text: string; nextIndex: number }
  | { ok: false; message: string } {
  const delimiter = script[index];
  if (delimiter === undefined) {
    return { ok: false, message: `unterminated ${label} command` };
  }
  if (!isSingleByteSedDelimiter({ delimiter })) {
    return {
      ok: false,
      message: "delimiter character is not a single-byte character",
    };
  }

  let cursor = index + 1;
  let text = "";
  let escaped = false;

  while (cursor < script.length) {
    if (sourceBoundaryIndices.has(cursor)) {
      return { ok: false, message: `unterminated ${label} command` };
    }
    const char = script[cursor];
    if (char === undefined) break;
    if (!escaped && char === "\n") {
      return { ok: false, message: `unterminated ${label} command` };
    }
    if (!escaped && char === delimiter) {
      return {
        ok: true,
        text,
        nextIndex: cursor + 1,
      };
    }
    text += char;
    escaped = !escaped && char === "\\";
    cursor += 1;
  }

  return { ok: false, message: `unterminated ${label} command` };
}

function decodeSedTranslateText({
  source,
  delimiter,
}: {
  source: string;
  delimiter: string;
}): string {
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== "\\" || index + 1 >= source.length) {
      result += character;
      continue;
    }

    const decoded = decodeSedExtendedEscape({
      source,
      backslashIndex: index,
    });
    if (decoded !== undefined) {
      result += decoded.value;
      index = decoded.lastIndex;
      continue;
    }

    const escaped = source[index + 1]!;
    if (escaped === "c") {
      // GNU sed treats a trailing \c in a y operand as an empty escape.
      // A following character would have been consumed by the extended
      // escape decoder above.
      index += 1;
      continue;
    }
    // GNU sed removes the escape marker for the delimiter, a literal
    // backslash, and otherwise-unknown transliteration escapes alike.
    // Unlike regexp parsing, \b therefore means a literal "b" here.
    result += escaped === delimiter ? delimiter : escaped;
    index += 1;
  }
  return result;
}

function haveEqualCodePointLength({
  left,
  right,
}: {
  left: string;
  right: string;
}): boolean {
  const leftCharacters = left[Symbol.iterator]();
  const rightCharacters = right[Symbol.iterator]();
  while (true) {
    const leftCharacter = leftCharacters.next();
    const rightCharacter = rightCharacters.next();
    if (leftCharacter.done || rightCharacter.done) {
      return leftCharacter.done === rightCharacter.done;
    }
  }
}

function parseTranslateCommand({
  script,
  index,
  address,
  rangeEnd,
  negated,
  characterLocaleMode,
  sourceBoundaryIndices,
}: {
  script: string;
  index: number;
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
  characterLocaleMode: WeshCharacterLocaleMode;
  sourceBoundaryIndices: ReadonlySet<number>;
}):
  | { ok: true; command: SedCommand; nextIndex: number }
  | { ok: false; message: string } {
  const source = parseDelimitedSedText({
    script,
    index: index + 1,
    label: "translate",
    sourceBoundaryIndices,
  });
  if (!source.ok) return source;

  const target = parseDelimitedSedText({
    script,
    index: source.nextIndex - 1,
    label: "translate",
    sourceBoundaryIndices,
  });
  if (!target.ok) return target;

  const delimiter = script[index + 1];
  if (delimiter === undefined) {
    return { ok: false, message: "unterminated translate command" };
  }
  const decodedSource = toSedLocaleText({
    text: decodeSedTranslateText({ source: source.text, delimiter }),
    characterLocaleMode,
  });
  const decodedTarget = toSedLocaleText({
    text: decodeSedTranslateText({ source: target.text, delimiter }),
    characterLocaleMode,
  });

  if (!haveEqualCodePointLength({ left: decodedSource, right: decodedTarget })) {
    return {
      ok: false,
      message: "strings for y command are different lengths",
    };
  }

  return {
    ok: true,
    command: {
      kind: "translate",
      address,
      rangeEnd,
      negated,
      source: decodedSource,
      target: decodedTarget,
      duplicateSourcePrecedence: (() => {
        switch (characterLocaleMode) {
        case "unicode":
          return "first";
        case "ascii":
          return "last";
        default: {
          const _ex: never = characterLocaleMode;
          throw new Error(`Unhandled character locale mode: ${_ex}`);
        }
        }
      })(),
    },
    nextIndex: target.nextIndex,
  };
}

function parseTextCommand({
  script,
  index,
  label,
  address,
  rangeEnd,
  negated,
  characterLocaleMode,
}: {
  script: string;
  index: number;
  label: "append" | "insert" | "change";
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
  characterLocaleMode: WeshCharacterLocaleMode;
}):
  | { ok: true; command: SedCommand; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index + 1;
  const hasExplicitTextIntroducer = script[cursor] === "\\";
  if (hasExplicitTextIntroducer) {
    cursor += 1;
    if (script[cursor] === "\n") {
      cursor += 1;
    } else if (script[cursor] === undefined) {
      return {
        ok: true,
        command: { kind: label, address, rangeEnd, negated, text: undefined },
        nextIndex: cursor,
      };
    }
  } else {
    while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
    if (script[cursor] === undefined) {
      return { ok: false, message: `expected \\ after '${label[0]}' command` };
    }
  }

  let text = "";
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined || char === "\n") break;
    if (char !== "\\") {
      text += char;
      cursor += 1;
      continue;
    }

    const escaped = script[cursor + 1];
    if (escaped === undefined) {
      cursor += 1;
      break;
    }
    if (escaped === "\n") {
      cursor += 2;
      if (text.length > 0 || cursor < script.length) text += "\n";
      continue;
    }

    const decoded = decodeSedExtendedEscape({
      source: script,
      backslashIndex: cursor,
    });
    if (decoded !== undefined) {
      text += decoded.value;
      cursor = decoded.lastIndex + 1;
      continue;
    }

    text += escaped;
    cursor += 2;
  }

  return {
    ok: true,
    command: {
      kind: label,
      address,
      rangeEnd,
      negated,
      text: toSedLocaleText({ text, characterLocaleMode }),
    },
    nextIndex: cursor,
  };
}


function parseExecuteCommand({
  script,
  index,
  address,
  rangeEnd,
  negated,
  characterLocaleMode,
}: {
  script: string;
  index: number;
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
  characterLocaleMode: WeshCharacterLocaleMode;
}): { ok: true; command: SedCommand; nextIndex: number } {
  let cursor = index + 1;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;

  let command = "";
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined || char === "\n") break;
    if (char !== "\\") {
      command += char;
      cursor += 1;
      continue;
    }

    const escaped = script[cursor + 1];
    if (escaped === undefined) {
      cursor += 1;
      break;
    }
    if (escaped === "\n") {
      command += "\n";
      cursor += 2;
      continue;
    }

    const decoded = decodeSedExtendedEscape({
      source: script,
      backslashIndex: cursor,
    });
    if (decoded !== undefined) {
      command += decoded.value;
      cursor = decoded.lastIndex + 1;
      continue;
    }

    command += escaped;
    cursor += 2;
  }

  return {
    ok: true,
    command: {
      kind: "execute",
      address,
      rangeEnd,
      negated,
      command:
        command.length === 0
          ? undefined
          : toSedLocaleText({ text: command, characterLocaleMode }),
    },
    nextIndex: cursor,
  };
}

function skipSeparators({
  script,
  index,
}: {
  script: string;
  index: number;
}): number {
  let cursor = index;
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === ";" || char === "\n" || char === " " || char === "\t") {
      cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

function parseOptionalSedUnsignedDecimal({
  script,
  index,
  label,
}: {
  script: string;
  index: number;
  label: string;
}):
  | { ok: true; valueText: string | undefined; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const start = cursor;
  while (/^[0-9]$/.test(script[cursor] ?? "")) cursor += 1;
  const valueText = cursor === start ? undefined : script.slice(start, cursor);
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const trailing = script[cursor];
  if (
    trailing !== undefined &&
    trailing !== ";" &&
    trailing !== "\n" &&
    trailing !== "}" &&
    trailing !== "#"
  ) {
    return { ok: false, message: `invalid ${label} argument` };
  }
  return { ok: true, valueText, nextIndex: cursor };
}

function parseOptionalSedListWidth({
  script,
  index,
  label,
}: {
  script: string;
  index: number;
  label: string;
}):
  | { ok: true; value: number | undefined; nextIndex: number }
  | { ok: false; message: string } {
  const parsed = parseOptionalSedUnsignedDecimal({ script, index, label });
  if (!parsed.ok) return parsed;
  if (parsed.valueText === undefined) {
    return { ok: true, value: undefined, nextIndex: parsed.nextIndex };
  }

  return {
    ok: true,
    value: parseSedScriptListWidth({ value: parsed.valueText }),
    nextIndex: parsed.nextIndex,
  };
}

function parseSedLabelOperand({
  script,
  index,
  requirement,
}: {
  script: string;
  index: number;
  requirement: "optional" | "required";
}):
  | { ok: true; label: string | undefined; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const start = cursor;
  while (
    cursor < script.length &&
    script[cursor] !== ";" &&
    script[cursor] !== "\n" &&
    script[cursor] !== "}" &&
    script[cursor] !== " " &&
    script[cursor] !== "\t" &&
    script[cursor] !== "#"
  )
    cursor += 1;
  const label = script.slice(start, cursor);
  if (label.length === 0) {
    switch (requirement) {
    case "required":
      return { ok: false, message: "empty label name" };
    case "optional":
      return { ok: true, label: undefined, nextIndex: cursor };
    default: {
      const _ex: never = requirement;
      throw new Error(`Unhandled sed label requirement: ${_ex}`);
    }
    }
  }
  return { ok: true, label, nextIndex: cursor };
}

function parseSedFileOperand({
  script,
  index,
  command,
}: {
  script: string;
  index: number;
  command: "r" | "R" | "w" | "W";
}):
  | { ok: true; path: string; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const start = cursor;
  while (cursor < script.length && script[cursor] !== "\n") cursor += 1;
  const path = script.slice(start, cursor);
  if (path.length === 0) {
    return { ok: false, message: `missing filename in ${command} command` };
  }
  return { ok: true, path, nextIndex: cursor };
}

export function validateSedLabels({
  commands,
}: {
  commands: readonly SedCommand[];
}): { ok: true } | { ok: false; message: string } {
  const labels = new Set<string>();
  for (const command of commands) {
    switch (command.kind) {
    case "label":
      labels.add(command.name);
      break;
    case "substitute":
    case "translate":
    case "append":
    case "insert":
    case "change":
    case "print":
    case "printFirst":
    case "list":
    case "lineNumber":
    case "hold":
    case "holdAppend":
    case "get":
    case "getAppend":
    case "exchange":
    case "delete":
    case "deleteFirst":
    case "next":
    case "nextAppend":
    case "readFile":
    case "readFileLine":
    case "writeFile":
    case "writeFileFirst":
    case "clear":
    case "fileName":
    case "execute":
    case "quit":
    case "branch":
    case "branchIfSubstituted":
    case "branchIfNotSubstituted":
    case "groupStart":
    case "groupEnd":
      break;
    default: {
      const _ex: never = command;
      throw new Error(
        `Unhandled sed command while collecting labels: ${JSON.stringify(_ex)}`,
      );
    }
    }
  }
  for (const command of commands) {
    switch (command.kind) {
    case "branch":
    case "branchIfSubstituted":
    case "branchIfNotSubstituted":
      if (
        command.targetLabel !== undefined &&
          !labels.has(command.targetLabel)
      ) {
        return {
          ok: false,
          message: `can't find label for jump to '${command.targetLabel}'`,
        };
      }
      break;
    case "substitute":
    case "translate":
    case "append":
    case "insert":
    case "change":
    case "print":
    case "printFirst":
    case "list":
    case "lineNumber":
    case "hold":
    case "holdAppend":
    case "get":
    case "getAppend":
    case "exchange":
    case "delete":
    case "deleteFirst":
    case "next":
    case "nextAppend":
    case "readFile":
    case "readFileLine":
    case "writeFile":
    case "writeFileFirst":
    case "clear":
    case "fileName":
    case "execute":
    case "quit":
    case "label":
    case "groupStart":
    case "groupEnd":
      break;
    default: {
      const _ex: never = command;
      throw new Error(
        `Unhandled sed command while validating labels: ${JSON.stringify(_ex)}`,
      );
    }
    }
  }
  return { ok: true };
}

function validateSedCommandBoundary({
  script,
  index,
}: {
  script: string;
  index: number;
}): { ok: true; nextIndex: number } | { ok: false; message: string } {
  let cursor = index;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const trailing = script[cursor];
  if (
    trailing === undefined
    || trailing === ";"
    || trailing === "\n"
    || trailing === "}"
    || trailing === "#"
  ) {
    return { ok: true, nextIndex: cursor };
  }
  return { ok: false, message: "extra characters after command" };
}

function parseSedScript({
  script,
  state,
  compileEffects,
}: {
  script: string;
  state: SedParseState;
  compileEffects: SedCompileEffects;
}): SedScriptParseResult {
  const commands: SedCommand[] = [];
  const groupStartIndices: number[] = [];
  let index = 0;

  while (index < script.length) {
    index = skipSeparators({ script, index });
    if (index >= script.length) break;

    if (script[index] === "#") {
      while (index < script.length && script[index] !== "\n") index += 1;
      continue;
    }

    const firstAddress = parseAddress({
      script,
      index,
      state,
      allowRelative: false,
    });
    if (!firstAddress.ok) return firstAddress;
    const address = firstAddress.address;
    index = firstAddress.nextIndex;

    let rangeEnd: SedAddress | undefined;
    let rangeSeparatorIndex = index;
    while (
      script[rangeSeparatorIndex] === " " ||
      script[rangeSeparatorIndex] === "\t"
    ) {
      rangeSeparatorIndex += 1;
    }
    if (script[rangeSeparatorIndex] === ",") {
      let rangeAddressIndex = rangeSeparatorIndex + 1;
      while (script[rangeAddressIndex] === " " || script[rangeAddressIndex] === "\t") {
        rangeAddressIndex += 1;
      }
      const secondAddress = parseAddress({
        script,
        index: rangeAddressIndex,
        state,
        allowRelative: true,
      });
      if (!secondAddress.ok || secondAddress.address === undefined) {
        return { ok: false, message: "invalid range address" };
      }
      rangeEnd = secondAddress.address;
      index = secondAddress.nextIndex;
    }

    while (script[index] === " " || script[index] === "\t") index += 1;

    const hasInvalidZeroStep =
      address?.kind === "lineStep" && address.first === 0n && address.step === 0n;
    if (hasInvalidZeroStep) {
      return { ok: false, message: "invalid usage of line address 0" };
    }
    if (isZeroSedAddress({ address }) && rangeEnd === undefined) {
      return { ok: false, message: "invalid usage of line address 0" };
    }
    if (isZeroSedAddress({ address }) && rangeEnd?.kind !== "regex") {
      return { ok: false, message: "invalid usage of line address 0" };
    }

    let negated = false;
    if (script[index] === "!") {
      negated = true;
      index += 1;
      while (script[index] === " " || script[index] === "\t") index += 1;
    }

    const commandChar = script[index];
    if (commandChar === undefined) break;

    let requiresCommandBoundary = true;
    switch (commandChar) {
    case "s": {
      const parsed = parseSubstituteCommand({
        script,
        index,
        address,
        rangeEnd,
        negated,
        state,
      });
      if (!parsed.ok) return parsed;
      if (parsed.command.writePath !== undefined) {
        compileEffects.writePaths.push(parsed.command.writePath);
      }
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "p":
      commands.push({ kind: "print", address, rangeEnd, negated });
      index += 1;
      break;
    case "P":
      commands.push({ kind: "printFirst", address, rangeEnd, negated });
      index += 1;
      break;
    case "l": {
      const parsed = parseOptionalSedListWidth({
        script,
        index: index + 1,
        label: "list width",
      });
      if (!parsed.ok) return parsed;
      commands.push({
        kind: "list",
        address,
        rangeEnd,
        negated,
        width: parsed.value,
      });
      index = parsed.nextIndex;
      break;
    }
    case "=":
      commands.push({ kind: "lineNumber", address, rangeEnd, negated });
      index += 1;
      break;
    case "h":
      commands.push({ kind: "hold", address, rangeEnd, negated });
      index += 1;
      break;
    case "H":
      commands.push({ kind: "holdAppend", address, rangeEnd, negated });
      index += 1;
      break;
    case "g":
      commands.push({ kind: "get", address, rangeEnd, negated });
      index += 1;
      break;
    case "G":
      commands.push({ kind: "getAppend", address, rangeEnd, negated });
      index += 1;
      break;
    case "x":
      commands.push({ kind: "exchange", address, rangeEnd, negated });
      index += 1;
      break;
    case "d":
      commands.push({ kind: "delete", address, rangeEnd, negated });
      index += 1;
      break;
    case "D":
      commands.push({ kind: "deleteFirst", address, rangeEnd, negated });
      index += 1;
      break;
    case "n":
      commands.push({ kind: "next", address, rangeEnd, negated });
      index += 1;
      break;
    case "N":
      commands.push({ kind: "nextAppend", address, rangeEnd, negated });
      index += 1;
      break;
    case "r":
    case "R":
    case "w":
    case "W": {
      const parsed = parseSedFileOperand({
        script,
        index: index + 1,
        command: commandChar,
      });
      if (!parsed.ok) return parsed;
      const selection = { address, rangeEnd, negated };
      if (commandChar === "w" || commandChar === "W") {
        compileEffects.writePaths.push(parsed.path);
      }
      switch (commandChar) {
      case "r":
        commands.push({
          kind: "readFile",
          ...selection,
          path: parsed.path,
        });
        break;
      case "R":
        commands.push({
          kind: "readFileLine",
          ...selection,
          path: parsed.path,
        });
        break;
      case "w":
        commands.push({
          kind: "writeFile",
          ...selection,
          path: parsed.path,
        });
        break;
      case "W":
        commands.push({
          kind: "writeFileFirst",
          ...selection,
          path: parsed.path,
        });
        break;
      default: {
        const _ex: never = commandChar;
        throw new Error(`Unhandled sed file command: ${_ex}`);
      }
      }
      index = parsed.nextIndex;
      break;
    }
    case "e": {
      const parsed = parseExecuteCommand({
        script,
        index,
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
      });
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "z":
      commands.push({ kind: "clear", address, rangeEnd, negated });
      index += 1;
      break;
    case "F":
      commands.push({ kind: "fileName", address, rangeEnd, negated });
      index += 1;
      break;
    case "q":
    case "Q": {
      if (rangeEnd !== undefined) {
        return { ok: false, message: "command only uses one address" };
      }
      const parsed = parseOptionalSedUnsignedDecimal({
        script,
        index: index + 1,
        label: "quit status",
      });
      if (!parsed.ok) return parsed;
      commands.push({
        kind: "quit",
        address,
        rangeEnd,
        negated,
        printPattern: commandChar === "q",
        exitCode: parseSedQuitStatus({ value: parsed.valueText }),
      });
      index = parsed.nextIndex;
      break;
    }
    case ":": {
      if (address !== undefined || rangeEnd !== undefined || negated) {
        return { ok: false, message: ": doesn't want any addresses" };
      }
      const parsed = parseSedLabelOperand({
        script,
        index: index + 1,
        requirement: "required",
      });
      if (!parsed.ok) return parsed;
      commands.push({
        kind: "label",
        address: undefined,
        rangeEnd: undefined,
        negated: false,
        name: parsed.label!,
      });
      index = parsed.nextIndex;
      requiresCommandBoundary = false;
      break;
    }
    case "b":
    case "t":
    case "T": {
      const parsed = parseSedLabelOperand({
        script,
        index: index + 1,
        requirement: "optional",
      });
      if (!parsed.ok) return parsed;
      const selection = { address, rangeEnd, negated };
      switch (commandChar) {
      case "b":
        commands.push({
          kind: "branch",
          ...selection,
          targetLabel: parsed.label,
        });
        break;
      case "t":
        commands.push({
          kind: "branchIfSubstituted",
          ...selection,
          targetLabel: parsed.label,
        });
        break;
      case "T":
        commands.push({
          kind: "branchIfNotSubstituted",
          ...selection,
          targetLabel: parsed.label,
        });
        break;
      default: {
        const _ex: never = commandChar;
        throw new Error(`Unhandled sed branch command: ${_ex}`);
      }
      }
      index = parsed.nextIndex;
      requiresCommandBoundary = false;
      break;
    }
    case "{": {
      const startIndex = commands.length;
      commands.push({
        kind: "groupStart",
        address,
        rangeEnd,
        negated,
        endIndex: -1,
      });
      groupStartIndices.push(startIndex);
      index += 1;
      requiresCommandBoundary = false;
      break;
    }
    case "}": {
      if (address !== undefined || rangeEnd !== undefined || negated) {
        return { ok: false, message: "unexpected '}'" };
      }
      const startIndex = groupStartIndices.pop();
      if (startIndex === undefined)
        return { ok: false, message: "unexpected '}'" };
      const startCommand = commands[startIndex];
      if (startCommand === undefined)
        throw new Error("Invalid sed group parser state");
      switch (startCommand.kind) {
      case "groupStart":
        startCommand.endIndex = commands.length;
        break;
      case "substitute":
      case "translate":
      case "append":
      case "insert":
      case "change":
      case "print":
      case "printFirst":
      case "lineNumber":
      case "list":
      case "clear":
      case "fileName":
      case "execute":
      case "hold":
      case "holdAppend":
      case "get":
      case "getAppend":
      case "exchange":
      case "delete":
      case "deleteFirst":
      case "next":
      case "nextAppend":
      case "readFile":
      case "readFileLine":
      case "writeFile":
      case "writeFileFirst":
      case "quit":
      case "label":
      case "branch":
      case "branchIfSubstituted":
      case "branchIfNotSubstituted":
      case "groupEnd":
        throw new Error("Invalid sed group parser state");
      default: {
        const _ex: never = startCommand;
        throw new Error(
          `Unhandled sed command in group parser: ${JSON.stringify(_ex)}`,
        );
      }
      }
      commands.push({
        kind: "groupEnd",
        address: undefined,
        rangeEnd: undefined,
        negated: false,
      });
      index += 1;
      break;
    }
    case "y": {
      const parsed = parseTranslateCommand({
        script,
        index,
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
        sourceBoundaryIndices: state.sourceBoundaryIndices,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "a": {
      const parsed = parseTextCommand({
        script,
        index,
        label: "append",
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "i": {
      const parsed = parseTextCommand({
        script,
        index,
        label: "insert",
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "c": {
      const parsed = parseTextCommand({
        script,
        index,
        label: "change",
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    default:
      return {
        ok: false,
        message: `unsupported sed command '${commandChar}'`,
      };
    }

    if (requiresCommandBoundary) {
      const boundary = validateSedCommandBoundary({ script, index });
      if (!boundary.ok) return boundary;
      index = boundary.nextIndex;
    }
  }

  if (groupStartIndices.length > 0) {
    return {
      ok: false,
      message: "unmatched '{'",
      deferUntilFinalSource: true,
    };
  }

  return { ok: true, commands };
}

export function parseSedScripts({
  scripts,
  syntax,
  characterLocaleMode,
  nullData,
}: {
  scripts: readonly string[];
  syntax: SedRegularExpressionSyntax;
  characterLocaleMode: WeshCharacterLocaleMode;
  nullData: boolean;
}): {
  parsedScript: SedScriptParseResult;
  compileEffects: SedCompileEffects;
} {
  const joinedScript = scripts.join("\n");
  const sourceBoundaryIndices = new Set<number>();
  let sourceOffset = 0;
  for (let sourceIndex = 0; sourceIndex < scripts.length - 1; sourceIndex += 1) {
    sourceOffset += scripts[sourceIndex]!.length;
    sourceBoundaryIndices.add(sourceOffset);
    sourceOffset += 1;
  }

  const compileEffects: SedCompileEffects = { writePaths: [] };
  const parseState: SedParseState = {
    syntax,
    characterLocaleMode,
    nullData,
    sourceBoundaryIndices,
    previousRegex: undefined,
    previousCaptureCount: 0,
  };
  return {
    parsedScript: parseSedScript({
      script: joinedScript,
      state: parseState,
      compileEffects,
    }),
    compileEffects,
  };
}


export const TEST_ONLY = {
};
