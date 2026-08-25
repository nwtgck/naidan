import { createChangeGroups, createDiffOperations } from "./algorithm";
import {
  areBytesIdentical,
  createLineComparator,
  decodeLineForPattern,
  isBinaryInput,
  isBlankLine,
} from "./input";
import type { DiffByteWriter } from "./output";
import { writeDiffOutput } from "./output";
import type {
  DiffChangeGroup,
  DiffComparisonOptions,
  DiffInput,
  DiffOperation,
  DiffOutputOptions,
} from "./model";

export interface DiffCompareSettings {
  readonly comparisonOptions: DiffComparisonOptions;
  readonly outputOptions: DiffOutputOptions;
  readonly binaryMode: "detect" | "text";
  readonly reportIdenticalFiles: boolean;
  readonly ignoreBlankLineChanges: boolean;
  readonly ignoreMatchingLinePatterns: readonly RegExp[];
  readonly preferSpeedOverCompatibility: boolean;
}

function groupEveryLineMatches({
  input,
  start,
  count,
  pattern,
  comparisonOptions,
  characterLocaleMode,
}: {
  input: DiffInput;
  start: number;
  count: number;
  pattern: RegExp;
  comparisonOptions: DiffComparisonOptions;
  characterLocaleMode: DiffOutputOptions['characterLocaleMode'];
}): boolean {
  for (let offset = 0; offset < count; offset++) {
    const value = decodeLineForPattern({
      input,
      lineIndex: start + offset,
      stripTrailingCarriageReturn:
        comparisonOptions.stripTrailingCarriageReturn,
      characterLocaleMode,
    });
    pattern.lastIndex = 0;
    if (!pattern.test(value)) return false;
  }
  return true;
}

function shouldIgnoreGroup({
  group,
  left,
  right,
  settings,
}: {
  group: DiffChangeGroup;
  left: DiffInput;
  right: DiffInput;
  settings: DiffCompareSettings;
}): boolean {
  if (settings.ignoreBlankLineChanges) {
    let allBlank = true;
    for (let offset = 0; offset < group.leftCount; offset++) {
      allBlank &&= isBlankLine({
        input: left,
        lineIndex: group.leftStart + offset,
        stripTrailingCarriageReturn:
          settings.comparisonOptions.stripTrailingCarriageReturn,
      });
    }
    for (let offset = 0; offset < group.rightCount; offset++) {
      allBlank &&= isBlankLine({
        input: right,
        lineIndex: group.rightStart + offset,
        stripTrailingCarriageReturn:
          settings.comparisonOptions.stripTrailingCarriageReturn,
      });
    }
    if (allBlank) {
      return true;
    }
  }

  if (settings.ignoreMatchingLinePatterns.length > 0) {
    return settings.ignoreMatchingLinePatterns.some(
      (pattern) =>
        groupEveryLineMatches({
          input: left,
          start: group.leftStart,
          count: group.leftCount,
          pattern,
          comparisonOptions: settings.comparisonOptions,
          characterLocaleMode: settings.outputOptions.characterLocaleMode,
        }) &&
        groupEveryLineMatches({
          input: right,
          start: group.rightStart,
          count: group.rightCount,
          pattern,
          comparisonOptions: settings.comparisonOptions,
          characterLocaleMode: settings.outputOptions.characterLocaleMode,
        }),
    );
  }

  return false;
}

function partitionChangeGroups({
  groups,
  left,
  right,
  settings,
}: {
  groups: readonly DiffChangeGroup[];
  left: DiffInput;
  right: DiffInput;
  settings: DiffCompareSettings;
}): { changeGroups: DiffChangeGroup[]; ignoredGroups: DiffChangeGroup[] } {
  const changeGroups: DiffChangeGroup[] = [];
  const ignoredGroups: DiffChangeGroup[] = [];
  for (const group of groups) {
    if (shouldIgnoreGroup({ group, left, right, settings }))
      ignoredGroups.push(group);
    else changeGroups.push(group);
  }
  return { changeGroups, ignoredGroups };
}

async function writeIdenticalReport({
  writer,
  left,
  right,
}: {
  writer: DiffByteWriter;
  left: DiffInput;
  right: DiffInput;
}): Promise<void> {
  await writer.writeText({
    text: `Files ${left.displayName} and ${right.displayName} are identical\n`,
  });
  await writer.flush();
}

async function writeDifferentReport({
  writer,
  left,
  right,
  binary,
}: {
  writer: DiffByteWriter;
  left: DiffInput;
  right: DiffInput;
  binary: boolean;
}): Promise<void> {
  await writer.writeText({
    text: `${binary ? "Binary files" : "Files"} ${left.displayName} and ${right.displayName} differ\n`,
  });
  await writer.flush();
}

function requiresDetailedOutputForIdenticalInputs({
  options,
}: {
  options: DiffOutputOptions;
}): boolean {
  switch (options.mode.kind) {
  case "ifdef":
  case "side-by-side":
    return true;
  case "brief":
  case "normal":
  case "unified":
  case "context":
  case "ed":
  case "rcs":
    return false;
  default: {
    const _ex: never = options.mode;
    throw new Error(`Unhandled diff output mode: ${JSON.stringify(_ex)}`);
  }
  }
}

function isBriefMode({ options }: { options: DiffOutputOptions }): boolean {
  switch (options.mode.kind) {
  case "brief":
    return true;
  case "normal":
  case "unified":
  case "context":
  case "side-by-side":
  case "ed":
  case "rcs":
  case "ifdef":
    return false;
  default: {
    const _ex: never = options.mode;
    throw new Error(`Unhandled diff output mode: ${JSON.stringify(_ex)}`);
  }
  }
}

export async function compareDiffInputs({
  writer,
  left,
  right,
  settings,
  beforeDetailedOutput,
}: {
  writer: DiffByteWriter;
  left: DiffInput;
  right: DiffInput;
  settings: DiffCompareSettings;
  beforeDetailedOutput?: () => Promise<void>;
}): Promise<{
  different: boolean;
  operations: readonly DiffOperation[];
  changeGroups: readonly DiffChangeGroup[];
}> {
  if (areBytesIdentical({ left: left.lines.bytes, right: right.lines.bytes })) {
    const operations: DiffOperation[] =
      left.lines.starts.length === 0
        ? []
        : [
          {
            kind: "equal",
            leftStart: 0,
            rightStart: 0,
            length: left.lines.starts.length,
          },
        ];
    if (requiresDetailedOutputForIdenticalInputs({ options: settings.outputOptions })) {
      await beforeDetailedOutput?.();
      await writeDiffOutput({
        writer,
        left,
        right,
        operations,
        changeGroups: [],
        ignoredGroups: [],
        comparisonOptions: settings.comparisonOptions,
        outputOptions: settings.outputOptions,
      });
    }
    if (settings.reportIdenticalFiles) {
      await writeIdenticalReport({ writer, left, right });
    }
    return { different: false, operations, changeGroups: [] };
  }

  const binary =
    settings.binaryMode === "detect" &&
    (isBinaryInput({ input: left }) || isBinaryInput({ input: right }));
  if (binary) {
    await writeDifferentReport({
      writer,
      left,
      right,
      binary: !isBriefMode({ options: settings.outputOptions }),
    });
    return { different: true, operations: [], changeGroups: [] };
  }

  const areEqual = createLineComparator({
    left,
    right,
    options: settings.comparisonOptions,
  });
  const operations = createDiffOperations({
    leftLength: left.lines.starts.length,
    rightLength: right.lines.starts.length,
    areEqual,
    preferSpeedOverCompatibility: settings.preferSpeedOverCompatibility,
  });
  const allGroups = createChangeGroups({ operations });
  const { changeGroups, ignoredGroups } = partitionChangeGroups({
    groups: allGroups,
    left,
    right,
    settings,
  });

  if (changeGroups.length === 0) {
    switch (settings.outputOptions.mode.kind) {
    case "side-by-side":
    case "ifdef":
      await beforeDetailedOutput?.();
      await writeDiffOutput({
        writer,
        left,
        right,
        operations,
        changeGroups,
        ignoredGroups,
        comparisonOptions: settings.comparisonOptions,
        outputOptions: settings.outputOptions,
      });
      break;
    case "brief":
    case "normal":
    case "unified":
    case "context":
    case "ed":
    case "rcs":
      break;
    default: {
      const _ex: never = settings.outputOptions.mode;
      throw new Error(`Unhandled diff output mode: ${JSON.stringify(_ex)}`);
    }
    }
    if (settings.reportIdenticalFiles) {
      await writeIdenticalReport({ writer, left, right });
    }
    return { different: false, operations, changeGroups };
  }

  switch (settings.outputOptions.mode.kind) {
  case "brief":
    await writeDifferentReport({ writer, left, right, binary: false });
    return { different: true, operations, changeGroups };
  case "normal":
  case "unified":
  case "context":
  case "side-by-side":
  case "ed":
  case "rcs":
  case "ifdef":
    break;
  default: {
    const _ex: never = settings.outputOptions.mode;
    throw new Error(`Unhandled diff output mode: ${JSON.stringify(_ex)}`);
  }
  }

  await beforeDetailedOutput?.();
  await writeDiffOutput({
    writer,
    left,
    right,
    operations,
    changeGroups,
    ignoredGroups,
    comparisonOptions: settings.comparisonOptions,
    outputOptions: settings.outputOptions,
  });
  return { different: true, operations, changeGroups };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  shouldIgnoreGroup,
};
