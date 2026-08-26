import { createDiffOperations } from "@/features/wesh/commands/git/diff/algorithm";
import { createDiffInput, createLineComparator, decodeLine, getLineBytes } from "@/features/wesh/commands/git/diff/input";
import { createDiffByteWriter } from "@/features/wesh/commands/git/diff/output";
import type { DiffInput, DiffOperation } from "@/features/wesh/commands/git/diff/model";
import type { WeshFileHandle } from "@/features/wesh/types";
import { formatGitPatchPath, quoteGitPath } from "@/features/wesh/commands/git/path-output";

interface ParentVersion {
  objectId: string,
  bytes: Uint8Array,
}

interface ParentAlignment {
  presentResultLines: readonly boolean[],
  deletedBeforeResultLine: readonly (readonly number[])[],
}

function hasNul({ bytes }: { bytes: Uint8Array }): boolean {
  return bytes.includes(0);
}

function createAlignment({ parent, result }: { parent: DiffInput, result: DiffInput }): ParentAlignment {
  const operations = createDiffOperations({
    leftLength: parent.lines.starts.length,
    rightLength: result.lines.starts.length,
    areEqual: createLineComparator({ left: parent, right: result, options: {
      stripTrailingCarriageReturn: false,
      ignoreCase: false,
      ignoreTabExpansion: false,
      ignoreTrailingSpace: false,
      ignoreSpaceChange: false,
      ignoreAllSpace: false,
      tabSize: 8,
    } }),
  });
  const presentResultLines = Array.from({ length: result.lines.starts.length }, () => false);
  const deletedBeforeResultLine: number[][] = Array.from({ length: result.lines.starts.length + 1 }, () => []);
  for (const operation of operations) {
    switch (operation.kind) {
    case "equal":
      for (let offset = 0; offset < operation.length; offset += 1) {
        presentResultLines[operation.rightStart + offset] = true;
      }
      break;
    case "delete":
      deletedBeforeResultLine[operation.rightStart]!.push(...rangeIndices({ operation }));
      break;
    case "insert":
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled combined diff operation: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return { presentResultLines, deletedBeforeResultLine };
}

function rangeIndices({ operation }: { operation: Extract<DiffOperation, { kind: "delete" }> }): number[] {
  return Array.from({ length: operation.length }, (_, offset) => operation.leftStart + offset);
}

function linesEqual({ left, leftIndex, right, rightIndex }: {
  left: DiffInput,
  leftIndex: number,
  right: DiffInput,
  rightIndex: number,
}): boolean {
  return createLineComparator({ left, right, options: {
    stripTrailingCarriageReturn: false,
    ignoreCase: false,
    ignoreTabExpansion: false,
    ignoreTrailingSpace: false,
    ignoreSpaceChange: false,
    ignoreAllSpace: false,
    tabSize: 8,
  } })({ leftIndex, rightIndex });
}

interface CombinedHunk {
  firstStart: number,
  firstCount: number,
  secondStart: number,
  secondCount: number,
  resultStart: number,
  resultEnd: number,
}

function formatCombinedRange({ start, count }: { start: number, count: number }): string {
  if (count === 0) return `${start},0`;
  return `${start + 1},${count}`;
}

function parentBoundary({ alignment, resultBoundary }: {
  alignment: ParentAlignment,
  resultBoundary: number,
}): number {
  let parentLine = 0;
  for (let position = 0; position < resultBoundary; position += 1) {
    parentLine += alignment.deletedBeforeResultLine[position]!.length;
    if (alignment.presentResultLines[position]) parentLine += 1;
  }
  return parentLine;
}

function parentRangeCount({ alignment, resultStart, resultEnd, resultLength }: {
  alignment: ParentAlignment,
  resultStart: number,
  resultEnd: number,
  resultLength: number,
}): number {
  let count = 0;
  for (let position = resultStart; position < resultEnd; position += 1) {
    count += alignment.deletedBeforeResultLine[position]!.length;
    if (alignment.presentResultLines[position]) count += 1;
  }
  if (resultEnd === resultLength) count += alignment.deletedBeforeResultLine[resultEnd]!.length;
  return count;
}

function createCombinedHunks({ firstAlignment, secondAlignment, resultLength, contextLines }: {
  firstAlignment: ParentAlignment,
  secondAlignment: ParentAlignment,
  resultLength: number,
  contextLines: number,
}): CombinedHunk[] {
  const changes: { start: number, end: number }[] = [];
  for (let position = 0; position <= resultLength; position += 1) {
    const hasDeletion = firstAlignment.deletedBeforeResultLine[position]!.length > 0
      || secondAlignment.deletedBeforeResultLine[position]!.length > 0;
    const resultChanged = position < resultLength
      && (!firstAlignment.presentResultLines[position]! || !secondAlignment.presentResultLines[position]!);
    if (!hasDeletion && !resultChanged) continue;
    changes.push({ start: position, end: position + (resultChanged ? 1 : 0) });
  }
  if (changes.length === 0) return [];

  const hunks: CombinedHunk[] = [];
  let groupStart = changes[0]!.start;
  let groupEnd = changes[0]!.end;
  const flush = (): void => {
    const resultStart = Math.max(0, groupStart - contextLines);
    const resultEnd = Math.min(resultLength, groupEnd + contextLines);
    hunks.push({
      firstStart: parentBoundary({ alignment: firstAlignment, resultBoundary: resultStart }),
      firstCount: parentRangeCount({ alignment: firstAlignment, resultStart, resultEnd, resultLength }),
      secondStart: parentBoundary({ alignment: secondAlignment, resultBoundary: resultStart }),
      secondCount: parentRangeCount({ alignment: secondAlignment, resultStart, resultEnd, resultLength }),
      resultStart,
      resultEnd,
    });
  };

  for (let index = 1; index < changes.length; index += 1) {
    const next = changes[index]!;
    if (next.start - groupEnd <= contextLines * 2) {
      groupEnd = Math.max(groupEnd, next.end);
      continue;
    }
    flush();
    groupStart = next.start;
    groupEnd = next.end;
  }
  flush();
  return hunks;
}

function combinedFunctionSuffix({ result, beforeLine }: { result: DiffInput, beforeLine: number }): string {
  for (let lineIndex = beforeLine - 1; lineIndex >= 0; lineIndex -= 1) {
    const line = decodeLine({ input: result, lineIndex, stripTrailingCarriageReturn: false });
    if (line.length === 0 || /^\s/u.test(line)) continue;
    const combined = line.slice(0, -1);
    return combined.length === 0 ? "" : ` ${combined}`;
  }
  return "";
}

export async function writeTwoParentCombinedDiff({ handle, path, firstParent, secondParent, resultBytes, quoteNonAscii }: {
  handle: WeshFileHandle,
  path: string,
  firstParent: ParentVersion,
  secondParent: ParentVersion,
  resultBytes: Uint8Array,
  quoteNonAscii: boolean,
}): Promise<void> {
  if (hasNul({ bytes: firstParent.bytes }) || hasNul({ bytes: secondParent.bytes }) || hasNul({ bytes: resultBytes })) {
    const writer = createDiffByteWriter({ handle });
    const displayPath = quoteGitPath({ path, quoteNonAscii, quoteSpaces: false });
    await writer.writeText({ text: `diff --cc ${displayPath}\n` });
    await writer.writeText({ text: `index ${firstParent.objectId.slice(0, 7)},${secondParent.objectId.slice(0, 7)}..0000000\n` });
    await writer.writeText({ text: 'Binary files differ\n' });
    await writer.flush();
    return;
  }
  const first = createDiffInput({ displayName: path, resolvedPath: undefined, mtime: undefined, bytes: firstParent.bytes });
  const second = createDiffInput({ displayName: path, resolvedPath: undefined, mtime: undefined, bytes: secondParent.bytes });
  const result = createDiffInput({ displayName: path, resolvedPath: undefined, mtime: undefined, bytes: resultBytes });
  const firstAlignment = createAlignment({ parent: first, result });
  const secondAlignment = createAlignment({ parent: second, result });
  const hunks = createCombinedHunks({
    firstAlignment,
    secondAlignment,
    resultLength: result.lines.starts.length,
    contextLines: 3,
  });
  if (hunks.length === 0) return;

  const writer = createDiffByteWriter({ handle });
  const displayPath = quoteGitPath({ path, quoteNonAscii, quoteSpaces: false });
  const leftHeaderPath = formatGitPatchPath({ path, prefix: "a", quoteNonAscii, headerLabel: true });
  const rightHeaderPath = formatGitPatchPath({ path, prefix: "b", quoteNonAscii, headerLabel: true });
  await writer.writeText({ text: `diff --cc ${displayPath}\n` });
  await writer.writeText({ text: `index ${firstParent.objectId.slice(0, 7)},${secondParent.objectId.slice(0, 7)}..0000000\n` });
  await writer.writeText({ text: `--- ${leftHeaderPath}\n+++ ${rightHeaderPath}\n` });
  for (const hunk of hunks) {
    const functionSuffix = combinedFunctionSuffix({ result, beforeLine: hunk.resultStart });
    await writer.writeText({
      text: `@@@ -${formatCombinedRange({ start: hunk.firstStart, count: hunk.firstCount })} -${formatCombinedRange({ start: hunk.secondStart, count: hunk.secondCount })} +${formatCombinedRange({ start: hunk.resultStart, count: hunk.resultEnd - hunk.resultStart })} @@@${functionSuffix}\n`,
    });

    for (let position = hunk.resultStart; position <= hunk.resultEnd; position += 1) {
      const includeBoundaryDeletions = position < hunk.resultEnd
        || position === result.lines.starts.length;
      if (includeBoundaryDeletions) {
        const firstDeleted = firstAlignment.deletedBeforeResultLine[position]!;
        const secondDeleted = secondAlignment.deletedBeforeResultLine[position]!;
        const deletionOperations = createDiffOperations({
          leftLength: firstDeleted.length,
          rightLength: secondDeleted.length,
          areEqual: ({ leftIndex, rightIndex }) => linesEqual({
            left: first,
            leftIndex: firstDeleted[leftIndex]!,
            right: second,
            rightIndex: secondDeleted[rightIndex]!,
          }),
        });
        for (const operation of deletionOperations) {
          switch (operation.kind) {
          case "equal":
            for (let offset = 0; offset < operation.length; offset += 1) {
              await writer.writeText({ text: "--" });
              await writer.writeBytes({ bytes: getLineBytes({
                input: first,
                lineIndex: firstDeleted[operation.leftStart + offset]!,
                stripTrailingCarriageReturn: false,
              }) });
              await writer.writeText({ text: "\n" });
            }
            break;
          case "delete":
            for (let offset = 0; offset < operation.length; offset += 1) {
              await writer.writeText({ text: "- " });
              await writer.writeBytes({ bytes: getLineBytes({
                input: first,
                lineIndex: firstDeleted[operation.leftStart + offset]!,
                stripTrailingCarriageReturn: false,
              }) });
              await writer.writeText({ text: "\n" });
            }
            break;
          case "insert":
            for (let offset = 0; offset < operation.length; offset += 1) {
              await writer.writeText({ text: " -" });
              await writer.writeBytes({ bytes: getLineBytes({
                input: second,
                lineIndex: secondDeleted[operation.rightStart + offset]!,
                stripTrailingCarriageReturn: false,
              }) });
              await writer.writeText({ text: "\n" });
            }
            break;
          default: {
            const _ex: never = operation;
            throw new Error(`Unhandled combined deletion operation: ${JSON.stringify(_ex)}`);
          }
          }
        }
      }
      if (position === hunk.resultEnd) continue;
      await writer.writeText({ text: `${firstAlignment.presentResultLines[position] ? " " : "+"}${secondAlignment.presentResultLines[position] ? " " : "+"}` });
      await writer.writeBytes({ bytes: getLineBytes({ input: result, lineIndex: position, stripTrailingCarriageReturn: false }) });
      await writer.writeText({ text: "\n" });
    }
  }
  await writer.flush();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
