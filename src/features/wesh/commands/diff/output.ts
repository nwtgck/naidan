import type { WeshFileHandle } from '@/features/wesh/types';
import { getWeshCodePointDisplayWidth } from '@/features/wesh/utils/display-width';
import { createHunks } from './algorithm';
import { decodeLineForPattern, getLineBytes } from './input';
import type {
  DiffChangeGroup,
  DiffComparisonOptions,
  DiffHunk,
  DiffInput,
  DiffOperation,
  DiffOutputOptions,
} from './model';
import { quoteDiffFileName } from './quote';

const OUTPUT_BUFFER_SIZE = 64 * 1024;
const INCOMPLETE_LINE_MARKER = '\\ No newline at end of file\n';
const EMPTY_BYTES = new Uint8Array(0);

export interface DiffByteWriter {
  writeText({ text }: { text: string }): Promise<void>,
  writeBytes({ bytes }: { bytes: Uint8Array }): Promise<void>,
  flush(): Promise<void>,
}

function isEqualOperation({ operation }: { operation: DiffOperation }): boolean {
  switch (operation.kind) {
  case 'equal': return true;
  case 'delete':
  case 'insert': return false;
  default: {
    const _ex: never = operation;
    throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
  }
  }
}

function getOperationLineIndex({
  side,
  operation,
  offset,
}: {
  side: 'left' | 'right',
  operation: DiffOperation,
  offset: number,
}): number {
  switch (side) {
  case 'left': return operation.leftStart + offset;
  case 'right': return operation.rightStart + offset;
  default: {
    const _ex: never = side;
    throw new Error(`Unhandled diff side: ${_ex}`);
  }
  }
}

function resolveCommonLinePresentation({
  mode,
}: {
  mode: 'both' | 'left-only' | 'suppress',
}): {
  readonly shouldWrite: boolean,
  readonly includeRight: boolean,
  readonly marker: ' ' | '(',
} {
  switch (mode) {
  case 'both': return { shouldWrite: true, includeRight: true, marker: ' ' };
  case 'left-only': return { shouldWrite: true, includeRight: false, marker: '(' };
  case 'suppress': return { shouldWrite: false, includeRight: false, marker: ' ' };
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled common line mode: ${_ex}`);
  }
  }
}

async function writeAllBytes({
  handle,
  bytes,
}: {
  handle: WeshFileHandle,
  bytes: Uint8Array,
}): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write({
      buffer: bytes,
      offset,
      length: bytes.byteLength - offset,
    });
    if (bytesWritten === 0) {
      throw new Error('output stream accepted zero bytes');
    }
    offset += bytesWritten;
  }
}

export function createDiffByteWriter({ handle }: { handle: WeshFileHandle }): DiffByteWriter {
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(OUTPUT_BUFFER_SIZE);
  let length = 0;

  const flush = async (): Promise<void> => {
    if (length === 0) {
      return;
    }
    await writeAllBytes({ handle, bytes: buffer.subarray(0, length) });
    length = 0;
  };

  const writeBytes = async ({ bytes }: { bytes: Uint8Array }): Promise<void> => {
    if (bytes.byteLength >= OUTPUT_BUFFER_SIZE) {
      await flush();
      await writeAllBytes({ handle, bytes });
      return;
    }
    if (length + bytes.byteLength > buffer.byteLength) {
      await flush();
    }
    buffer.set(bytes, length);
    length += bytes.byteLength;
  };

  return {
    async writeText({ text }: { text: string }): Promise<void> {
      await writeBytes({ bytes: encoder.encode(text) });
    },
    writeBytes,
    flush,
  };
}

function pad2({ value }: { value: number }): string {
  return String(value).padStart(2, '0');
}

function pad3({ value }: { value: number }): string {
  return String(value).padStart(3, '0');
}

function formatTimezoneOffset({ date }: { date: Date }): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad2({ value: Math.floor(absolute / 60) })}${pad2({ value: absolute % 60 })}`;
}

function formatTimestamp({ mtime }: { mtime: number | undefined }): string {
  const date = new Date(mtime ?? 0);
  return `${date.getFullYear()}-${pad2({ value: date.getMonth() + 1 })}-${pad2({ value: date.getDate() })} ${pad2({ value: date.getHours() })}:${pad2({ value: date.getMinutes() })}:${pad2({ value: date.getSeconds() })}.${pad3({ value: date.getMilliseconds() })} ${formatTimezoneOffset({ date })}`;
}

function formatHeader({
  input,
  label,
}: {
  input: DiffInput,
  label: string | undefined,
}): string {
  if (label !== undefined) {
    return label;
  }
  return `${quoteDiffFileName({ value: input.displayName })}\t${formatTimestamp({ mtime: input.mtime })}`;
}

const CONTEXT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const CONTEXT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function formatContextTimestamp({ mtime }: { mtime: number | undefined }): string {
  const date = new Date(mtime ?? 0);
  return `${CONTEXT_WEEKDAYS[date.getDay()]} ${CONTEXT_MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')} ${pad2({ value: date.getHours() })}:${pad2({ value: date.getMinutes() })}:${pad2({ value: date.getSeconds() })} ${date.getFullYear()}`;
}

function formatContextHeader({
  input,
  label,
}: {
  input: DiffInput,
  label: string | undefined,
}): string {
  if (label !== undefined) {
    return label;
  }
  return `${quoteDiffFileName({ value: input.displayName })}\t${formatContextTimestamp({ mtime: input.mtime })}`;
}

function findFunctionLine({
  input,
  beforeLine,
  pattern,
  stripTrailingCarriageReturn,
  characterLocaleMode,
}: {
  input: DiffInput,
  beforeLine: number,
  pattern: RegExp | undefined,
  stripTrailingCarriageReturn: boolean,
  characterLocaleMode: DiffOutputOptions['characterLocaleMode'],
}): Uint8Array | undefined {
  if (pattern === undefined) {
    return undefined;
  }

  const start = Math.min(beforeLine - 1, input.lines.starts.length - 1);
  for (let lineIndex = start; lineIndex >= 0; lineIndex--) {
    const line = decodeLineForPattern({
      input,
      lineIndex,
      stripTrailingCarriageReturn,
      characterLocaleMode,
    });
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      const bytes = getLineBytes({ input, lineIndex, stripTrailingCarriageReturn });
      let startOffset = 0;
      let endOffset = bytes.byteLength;
      while (startOffset < endOffset && isFunctionLineWhitespace({ byte: bytes[startOffset]! })) {
        startOffset++;
      }
      while (endOffset > startOffset && isFunctionLineWhitespace({ byte: bytes[endOffset - 1]! })) {
        endOffset--;
      }
      return bytes.subarray(startOffset, endOffset);
    }
  }
  return undefined;
}

function isFunctionLineWhitespace({ byte }: { byte: number }): boolean {
  return byte === 0x09
    || byte === 0x0b
    || byte === 0x0c
    || byte === 0x0d
    || byte === 0x20;
}

async function writeFunctionSuffix({
  writer,
  value,
}: {
  writer: DiffByteWriter,
  value: Uint8Array | undefined,
}): Promise<void> {
  if (value === undefined) {
    return;
  }
  await writer.writeText({ text: ' ' });
  await writer.writeBytes({ bytes: value });
}

async function writeBytesWithExpandedTabs({
  writer,
  bytes,
  tabSize,
  initialColumn,
}: {
  writer: DiffByteWriter,
  bytes: Uint8Array,
  tabSize: number,
  initialColumn: number,
}): Promise<void> {
  let column = initialColumn;
  let chunkStart = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0x09) {
      column++;
      continue;
    }
    if (chunkStart < index) {
      await writer.writeBytes({ bytes: bytes.subarray(chunkStart, index) });
    }
    const spaces = tabSize - (column % tabSize);
    await writer.writeText({ text: ' '.repeat(spaces) });
    column += spaces;
    chunkStart = index + 1;
  }
  if (chunkStart < bytes.byteLength) {
    await writer.writeBytes({ bytes: bytes.subarray(chunkStart) });
  }
}

async function writeInputLine({
  writer,
  input,
  lineIndex,
  prefix,
  comparisonOptions,
  outputOptions,
}: {
  writer: DiffByteWriter,
  input: DiffInput,
  lineIndex: number,
  prefix: string,
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
}): Promise<void> {
  const bytes = getLineBytes({
    input,
    lineIndex,
    stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn,
  });
  const isEmpty = bytes.byteLength === 0;
  const visiblePrefix = outputOptions.suppressBlankEmpty && isEmpty ? prefix.trimEnd() : prefix;
  await writer.writeText({ text: visiblePrefix });
  if (outputOptions.initialTab && !isEmpty) {
    await writer.writeText({ text: '\t' });
  }

  if (outputOptions.expandTabs) {
    await writeBytesWithExpandedTabs({
      writer,
      bytes,
      tabSize: outputOptions.tabSize,
      initialColumn: 0,
    });
  } else {
    await writer.writeBytes({ bytes });
  }

  await writer.writeText({ text: '\n' });
  if (input.lines.hasLineFeed[lineIndex] !== 1) {
    await writer.writeText({ text: INCOMPLETE_LINE_MARKER });
  }
}

async function writeScriptInputLine({
  writer,
  input,
  lineIndex,
  comparisonOptions,
  outputOptions,
  forceLineFeed,
  escapeEdTerminator,
}: {
  writer: DiffByteWriter,
  input: DiffInput,
  lineIndex: number,
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
  forceLineFeed: boolean,
  escapeEdTerminator: boolean,
}): Promise<{ readonly incomplete: boolean, readonly escapedEdTerminator: boolean }> {
  const bytes = getLineBytes({
    input,
    lineIndex,
    stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn,
  });
  const isEmpty = bytes.byteLength === 0;
  const prependTab = outputOptions.initialTab && !isEmpty;
  const isEdTerminator = escapeEdTerminator
    && !prependTab
    && bytes.byteLength === 1
    && bytes[0] === 0x2E;

  if (prependTab) {
    await writer.writeText({ text: '\t' });
  }
  if (isEdTerminator) {
    await writer.writeText({ text: '..' });
  } else if (outputOptions.expandTabs) {
    await writeBytesWithExpandedTabs({
      writer,
      bytes,
      tabSize: outputOptions.tabSize,
      initialColumn: 0,
    });
  } else {
    await writer.writeBytes({ bytes });
  }

  const incomplete = input.lines.hasLineFeed[lineIndex] !== 1;
  if (forceLineFeed || !incomplete) {
    await writer.writeText({ text: '\n' });
  }
  return {
    incomplete,
    escapedEdTerminator: isEdTerminator,
  };
}

function formatNormalRange({ start, count }: { start: number, count: number }): string {
  const first = start + 1;
  return count === 1 ? String(first) : `${first},${start + count}`;
}

function formatUnifiedRange({ start, count }: { start: number, count: number }): string {
  if (count === 0) {
    return `${start},0`;
  }
  const first = start + 1;
  return count === 1 ? String(first) : `${first},${count}`;
}

function formatContextRange({ start, count }: { start: number, count: number }): string {
  if (count === 0) {
    return String(start);
  }
  const first = start + 1;
  return count === 1 ? String(first) : `${first},${start + count}`;
}

async function writeNormal({
  writer,
  left,
  right,
  changeGroups,
  comparisonOptions,
  outputOptions,
}: {
  writer: DiffByteWriter,
  left: DiffInput,
  right: DiffInput,
  changeGroups: readonly DiffChangeGroup[],
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
}): Promise<void> {
  for (const group of changeGroups) {
    if (group.leftCount === 0) {
      await writer.writeText({
        text: `${group.leftStart}a${formatNormalRange({ start: group.rightStart, count: group.rightCount })}\n`,
      });
    } else if (group.rightCount === 0) {
      await writer.writeText({
        text: `${formatNormalRange({ start: group.leftStart, count: group.leftCount })}d${group.rightStart}\n`,
      });
    } else {
      await writer.writeText({
        text: `${formatNormalRange({ start: group.leftStart, count: group.leftCount })}c${formatNormalRange({ start: group.rightStart, count: group.rightCount })}\n`,
      });
    }

    for (let offset = 0; offset < group.leftCount; offset++) {
      await writeInputLine({
        writer,
        input: left,
        lineIndex: group.leftStart + offset,
        prefix: '< ',
        comparisonOptions,
        outputOptions,
      });
    }
    if (group.leftCount > 0 && group.rightCount > 0) {
      await writer.writeText({ text: '---\n' });
    }
    for (let offset = 0; offset < group.rightCount; offset++) {
      await writeInputLine({
        writer,
        input: right,
        lineIndex: group.rightStart + offset,
        prefix: '> ',
        comparisonOptions,
        outputOptions,
      });
    }
  }
}

function isLineInsideHunk({
  operation,
  offset,
  hunk,
}: {
  operation: DiffOperation,
  offset: number,
  hunk: DiffHunk,
}): boolean {
  switch (operation.kind) {
  case 'equal': {
    const leftIndex = operation.leftStart + offset;
    const rightIndex = operation.rightStart + offset;
    return leftIndex >= hunk.leftStart
      && leftIndex < hunk.leftStart + hunk.leftCount
      && rightIndex >= hunk.rightStart
      && rightIndex < hunk.rightStart + hunk.rightCount;
  }
  case 'delete': {
    const leftIndex = operation.leftStart + offset;
    return leftIndex >= hunk.leftStart
      && leftIndex < hunk.leftStart + hunk.leftCount
      && operation.rightStart >= hunk.rightStart
      && operation.rightStart <= hunk.rightStart + hunk.rightCount;
  }
  case 'insert': {
    const rightIndex = operation.rightStart + offset;
    return rightIndex >= hunk.rightStart
      && rightIndex < hunk.rightStart + hunk.rightCount
      && operation.leftStart >= hunk.leftStart
      && operation.leftStart <= hunk.leftStart + hunk.leftCount;
  }
  default: {
    const _ex: never = operation;
    throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
  }
  }
}

async function writeUnified({
  writer,
  left,
  right,
  operations,
  changeGroups,
  comparisonOptions,
  outputOptions,
  contextLines,
}: {
  writer: DiffByteWriter,
  left: DiffInput,
  right: DiffInput,
  operations: readonly DiffOperation[],
  changeGroups: readonly DiffChangeGroup[],
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
  contextLines: number,
}): Promise<void> {
  await writer.writeText({ text: `--- ${formatHeader({ input: left, label: outputOptions.labels[0] })}\n` });
  await writer.writeText({ text: `+++ ${formatHeader({ input: right, label: outputOptions.labels[1] })}\n` });

  const hunks = createHunks({
    operations,
    changeGroups,
    contextLines,
    leftLength: left.lines.starts.length,
    rightLength: right.lines.starts.length,
  });

  for (const hunk of hunks) {
    const functionLine = findFunctionLine({
      input: left,
      beforeLine: hunk.leftStart,
      pattern: outputOptions.functionLinePattern,
      stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn,
      characterLocaleMode: outputOptions.characterLocaleMode,
    });
    await writer.writeText({
      text: `@@ -${formatUnifiedRange({ start: hunk.leftStart, count: hunk.leftCount })} +${formatUnifiedRange({ start: hunk.rightStart, count: hunk.rightCount })} @@`,
    });
    await writeFunctionSuffix({ writer, value: functionLine });
    await writer.writeText({ text: '\n' });

    let operationIndex = hunk.operationStart;
    while (operationIndex < hunk.operationEnd) {
      const operation = operations[operationIndex];
      if (operation === undefined) {
        operationIndex++;
        continue;
      }

      switch (operation.kind) {
      case 'equal':
        for (let offset = 0; offset < operation.length; offset++) {
          if (!isLineInsideHunk({ operation, offset, hunk })) {
            continue;
          }
          await writeInputLine({ writer, input: left, lineIndex: operation.leftStart + offset, prefix: ' ', comparisonOptions, outputOptions });
        }
        operationIndex++;
        continue;
      case 'delete':
      case 'insert':
        break;
      default: {
        const _ex: never = operation;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }

      const blockStart = operationIndex;
      while (operationIndex < hunk.operationEnd) {
        const current = operations[operationIndex];
        if (current === undefined || current.kind === 'equal') {
          break;
        }
        operationIndex++;
      }

      for (const kind of ['delete', 'insert'] as const) {
        for (let blockIndex = blockStart; blockIndex < operationIndex; blockIndex++) {
          const current = operations[blockIndex];
          if (current === undefined || current.kind !== kind) {
            continue;
          }
          for (let offset = 0; offset < current.length; offset++) {
            if (!isLineInsideHunk({ operation: current, offset, hunk })) {
              continue;
            }
            switch (kind) {
            case 'delete':
              await writeInputLine({ writer, input: left, lineIndex: current.leftStart + offset, prefix: '-', comparisonOptions, outputOptions });
              break;
            case 'insert':
              await writeInputLine({ writer, input: right, lineIndex: current.rightStart + offset, prefix: '+', comparisonOptions, outputOptions });
              break;
            default: {
              const _ex: never = kind;
              throw new Error(`Unhandled change kind: ${_ex}`);
            }
            }
          }
        }
      }
    }
  }
}

function hunkContainsOperationKind({
  operations,
  hunk,
  kind,
}: {
  operations: readonly DiffOperation[],
  hunk: DiffHunk,
  kind: 'delete' | 'insert',
}): boolean {
  for (let operationIndex = hunk.operationStart; operationIndex < hunk.operationEnd; operationIndex++) {
    const operation = operations[operationIndex];
    if (operation === undefined || operation.kind !== kind) {
      continue;
    }
    for (let offset = 0; offset < operation.length; offset++) {
      if (isLineInsideHunk({ operation, offset, hunk })) {
        return true;
      }
    }
  }
  return false;
}

async function writeContextSection({
  writer,
  side,
  input,
  operations,
  hunk,
  comparisonOptions,
  outputOptions,
}: {
  writer: DiffByteWriter,
  side: 'left' | 'right',
  input: DiffInput,
  operations: readonly DiffOperation[],
  hunk: DiffHunk,
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
}): Promise<void> {
  let operationIndex = hunk.operationStart;
  while (operationIndex < hunk.operationEnd) {
    const operation = operations[operationIndex];
    if (operation === undefined) {
      break;
    }
    if (isEqualOperation({ operation })) {
      for (let offset = 0; offset < operation.length; offset++) {
        if (isLineInsideHunk({ operation, offset, hunk })) {
          await writeInputLine({
            writer,
            input,
            lineIndex: getOperationLineIndex({ side, operation, offset }),
            prefix: '  ',
            comparisonOptions,
            outputOptions,
          });
        }
      }
      operationIndex++;
      continue;
    }

    const blockStart = operationIndex;
    let hasDelete = false;
    let hasInsert = false;
    while (operationIndex < hunk.operationEnd) {
      const current = operations[operationIndex];
      if (current === undefined || isEqualOperation({ operation: current })) {
        break;
      }
      switch (current.kind) {
      case 'delete': hasDelete = true; break;
      case 'insert': hasInsert = true; break;
      case 'equal': break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }
      operationIndex++;
    }

    for (let blockIndex = blockStart; blockIndex < operationIndex; blockIndex++) {
      const current = operations[blockIndex];
      if (current === undefined) {
        continue;
      }
      switch (side) {
      case 'left':
        switch (current.kind) {
        case 'delete':
          for (let offset = 0; offset < current.length; offset++) {
            if (isLineInsideHunk({ operation: current, offset, hunk })) {
              await writeInputLine({ writer, input, lineIndex: current.leftStart + offset, prefix: hasInsert ? '! ' : '- ', comparisonOptions, outputOptions });
            }
          }
          break;
        case 'equal':
        case 'insert': break;
        default: {
          const _ex: never = current;
          throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      case 'right':
        switch (current.kind) {
        case 'insert':
          for (let offset = 0; offset < current.length; offset++) {
            if (isLineInsideHunk({ operation: current, offset, hunk })) {
              await writeInputLine({ writer, input, lineIndex: current.rightStart + offset, prefix: hasDelete ? '! ' : '+ ', comparisonOptions, outputOptions });
            }
          }
          break;
        case 'equal':
        case 'delete': break;
        default: {
          const _ex: never = current;
          throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      default: {
        const _ex: never = side;
        throw new Error(`Unhandled diff side: ${_ex}`);
      }
      }
    }
  }
}

async function writeContext({
  writer,
  left,
  right,
  operations,
  changeGroups,
  comparisonOptions,
  outputOptions,
  contextLines,
}: {
  writer: DiffByteWriter,
  left: DiffInput,
  right: DiffInput,
  operations: readonly DiffOperation[],
  changeGroups: readonly DiffChangeGroup[],
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
  contextLines: number,
}): Promise<void> {
  await writer.writeText({ text: `*** ${formatContextHeader({ input: left, label: outputOptions.labels[0] })}\n` });
  await writer.writeText({ text: `--- ${formatContextHeader({ input: right, label: outputOptions.labels[1] })}\n` });
  const hunks = createHunks({
    operations,
    changeGroups,
    contextLines,
    leftLength: left.lines.starts.length,
    rightLength: right.lines.starts.length,
  });

  for (const hunk of hunks) {
    const functionLine = findFunctionLine({
      input: left,
      beforeLine: hunk.leftStart,
      pattern: outputOptions.functionLinePattern,
      stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn,
      characterLocaleMode: outputOptions.characterLocaleMode,
    });
    await writer.writeText({ text: '***************' });
    await writeFunctionSuffix({ writer, value: functionLine });
    await writer.writeText({ text: '\n' });
    await writer.writeText({ text: `*** ${formatContextRange({ start: hunk.leftStart, count: hunk.leftCount })} ****\n` });
    if (hunkContainsOperationKind({ operations, hunk, kind: 'delete' })) {
      await writeContextSection({ writer, side: 'left', input: left, operations, hunk, comparisonOptions, outputOptions });
    }
    await writer.writeText({ text: `--- ${formatContextRange({ start: hunk.rightStart, count: hunk.rightCount })} ----\n` });
    if (hunkContainsOperationKind({ operations, hunk, kind: 'insert' })) {
      await writeContextSection({ writer, side: 'right', input: right, operations, hunk, comparisonOptions, outputOptions });
    }
  }
}

async function writeEd({
  writer,
  right,
  changeGroups,
  comparisonOptions,
  outputOptions,
}: {
  writer: DiffByteWriter,
  right: DiffInput,
  changeGroups: readonly DiffChangeGroup[],
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
}): Promise<void> {
  for (let index = changeGroups.length - 1; index >= 0; index--) {
    const group = changeGroups[index];
    if (group === undefined) {
      continue;
    }
    if (group.leftCount === 0) {
      await writer.writeText({ text: `${group.leftStart}a\n` });
    } else if (group.rightCount === 0) {
      await writer.writeText({ text: `${formatNormalRange({ start: group.leftStart, count: group.leftCount })}d\n` });
      continue;
    } else {
      await writer.writeText({ text: `${formatNormalRange({ start: group.leftStart, count: group.leftCount })}c\n` });
    }

    let hasIncompleteLine = false;
    let inputBlockOpen = true;
    for (let offset = 0; offset < group.rightCount; offset++) {
      if (!inputBlockOpen) {
        await writer.writeText({ text: 'a\n' });
        inputBlockOpen = true;
      }
      const result = await writeScriptInputLine({
        writer,
        input: right,
        lineIndex: group.rightStart + offset,
        comparisonOptions,
        outputOptions,
        forceLineFeed: true,
        escapeEdTerminator: true,
      });
      hasIncompleteLine ||= result.incomplete;
      if (result.escapedEdTerminator) {
        await writer.writeText({ text: `\
.
s/.//
` });
        inputBlockOpen = false;
      }
    }
    if (inputBlockOpen) {
      await writer.writeText({ text: '.\n' });
    }
    if (hasIncompleteLine) {
      await writer.flush();
      throw new Error(`${right.displayName}: No newline at end of file`);
    }
  }
}

async function writeRcs({
  writer,
  right,
  changeGroups,
  comparisonOptions,
  outputOptions,
}: {
  writer: DiffByteWriter,
  right: DiffInput,
  changeGroups: readonly DiffChangeGroup[],
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
}): Promise<void> {
  for (const group of changeGroups) {
    if (group.leftCount > 0) {
      await writer.writeText({ text: `d${group.leftStart + 1} ${group.leftCount}\n` });
    }
    if (group.rightCount > 0) {
      await writer.writeText({ text: `a${group.leftStart + group.leftCount} ${group.rightCount}\n` });
      for (let offset = 0; offset < group.rightCount; offset++) {
        await writeScriptInputLine({
          writer,
          input: right,
          lineIndex: group.rightStart + offset,
          comparisonOptions,
          outputOptions,
          forceLineFeed: false,
          escapeEdTerminator: false,
        });
      }
    }
  }
}

interface SideBySideLayout {
  readonly halfWidth: number,
  readonly column2Offset: number,
  readonly markerColumn: number,
}

function resolveSideBySideLayout({
  width,
  tabSize,
  expandTabsInOutput,
}: {
  width: number,
  tabSize: number,
  expandTabsInOutput: boolean,
}): SideBySideLayout {
  const alignment = expandTabsInOutput ? 1 : tabSize;
  const alignmentWithGutter = alignment + 3;
  const unalignedOffset = (width >> 1)
    + (alignmentWithGutter >> 1)
    + ((width & alignmentWithGutter & 1) === 0 ? 0 : 1);
  const column2Offset = unalignedOffset - (unalignedOffset % alignment);
  const halfWidth = column2Offset <= 3 || width <= column2Offset
    ? 0
    : Math.min(column2Offset - 3, width - column2Offset);
  const effectiveColumn2Offset = halfWidth === 0 ? width : column2Offset;
  return {
    halfWidth,
    column2Offset: effectiveColumn2Offset,
    markerColumn: halfWidth === 0
      ? Math.floor((width - 1) / 2)
      : halfWidth + Math.floor((effectiveColumn2Offset - halfWidth - 1) / 2),
  };
}

function isUtf8ContinuationByte({ value }: { value: number | undefined }): boolean {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}

function getValidUtf8SequenceLength({
  bytes,
  index,
}: {
  bytes: Uint8Array,
  index: number,
}): number {
  const first = bytes[index];
  if (first === undefined || first < 0x80) return 1;
  const second = bytes[index + 1];
  if (first >= 0xc2 && first <= 0xdf) {
    return isUtf8ContinuationByte({ value: second }) ? 2 : 1;
  }
  const third = bytes[index + 2];
  if (first === 0xe0) {
    return second !== undefined && second >= 0xa0 && second <= 0xbf
      && isUtf8ContinuationByte({ value: third }) ? 3 : 1;
  }
  if ((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef)) {
    return isUtf8ContinuationByte({ value: second })
      && isUtf8ContinuationByte({ value: third }) ? 3 : 1;
  }
  if (first === 0xed) {
    return second !== undefined && second >= 0x80 && second <= 0x9f
      && isUtf8ContinuationByte({ value: third }) ? 3 : 1;
  }
  const fourth = bytes[index + 3];
  if (first === 0xf0) {
    return second !== undefined && second >= 0x90 && second <= 0xbf
      && isUtf8ContinuationByte({ value: third })
      && isUtf8ContinuationByte({ value: fourth }) ? 4 : 1;
  }
  if (first >= 0xf1 && first <= 0xf3) {
    return isUtf8ContinuationByte({ value: second })
      && isUtf8ContinuationByte({ value: third })
      && isUtf8ContinuationByte({ value: fourth }) ? 4 : 1;
  }
  if (first === 0xf4) {
    return second !== undefined && second >= 0x80 && second <= 0x8f
      && isUtf8ContinuationByte({ value: third })
      && isUtf8ContinuationByte({ value: fourth }) ? 4 : 1;
  }
  return 1;
}

function decodeValidUtf8CodePoint({
  bytes,
  index,
  sequenceLength,
}: {
  bytes: Uint8Array,
  index: number,
  sequenceLength: number,
}): number {
  const first = bytes[index] ?? 0;
  switch (sequenceLength) {
  case 1:
    return first;
  case 2:
    return ((first & 0x1F) << 6)
      | ((bytes[index + 1] ?? 0) & 0x3F);
  case 3:
    return ((first & 0x0F) << 12)
      | (((bytes[index + 1] ?? 0) & 0x3F) << 6)
      | ((bytes[index + 2] ?? 0) & 0x3F);
  case 4:
    return ((first & 0x07) << 18)
      | (((bytes[index + 1] ?? 0) & 0x3F) << 12)
      | (((bytes[index + 2] ?? 0) & 0x3F) << 6)
      | ((bytes[index + 3] ?? 0) & 0x3F);
  default:
    throw new Error(`Unhandled UTF-8 sequence length: ${sequenceLength}`);
  }
}


function outputOptionsCharacterWidth({
  bytes,
  index,
  characterLocaleMode,
}: {
  bytes: Uint8Array,
  index: number,
  characterLocaleMode: DiffOutputOptions['characterLocaleMode'],
}): { readonly byteLength: number, readonly columnWidth: number } {
  switch (characterLocaleMode) {
  case 'ascii': {
    const byte = bytes[index] ?? 0;
    return {
      byteLength: 1,
      columnWidth: byte >= 0x20 && byte <= 0x7E ? 1 : 0,
    };
  }
  case 'unicode': {
    const byteLength = getValidUtf8SequenceLength({ bytes, index });
    if (byteLength === 1 && (bytes[index] ?? 0) >= 0x80) {
      return { byteLength: 1, columnWidth: 1 };
    }
    const codePoint = decodeValidUtf8CodePoint({ bytes, index, sequenceLength: byteLength });
    return {
      byteLength,
      columnWidth: getWeshCodePointDisplayWidth({ codePoint }),
    };
  }
  default: {
    const _exhaustive: never = characterLocaleMode;
    throw new Error(`Unhandled character locale mode: ${_exhaustive}`);
  }
  }
}


async function writeSideBySideColumn({
  writer,
  bytes,
  startColumn,
  width,
  tabSize,
  expandTabsInOutput,
  characterLocaleMode,
}: {
  writer: DiffByteWriter,
  bytes: Uint8Array,
  startColumn: number,
  width: number,
  tabSize: number,
  expandTabsInOutput: boolean,
  characterLocaleMode: DiffOutputOptions['characterLocaleMode'],
}): Promise<number> {
  let column = startColumn;
  const endColumn = startColumn + width;
  let index = 0;
  let chunkStart = 0;
  let clipped = false;

  while (index < bytes.byteLength) {
    if (bytes[index] === 0x0D) {
      if (chunkStart < index) {
        await writer.writeBytes({ bytes: bytes.subarray(chunkStart, index) });
      }
      await writer.writeBytes({ bytes: bytes.subarray(index, index + 1) });
      index++;
      column = 0;
      if (startColumn > 0) {
        const resetPadding = padSideBySideToColumn({
          currentColumn: 0,
          targetColumn: startColumn,
          tabSize,
          useTabs: !expandTabsInOutput,
        });
        await writer.writeText({ text: resetPadding.text });
        column = resetPadding.endColumn;
      }
      clipped = false;
      chunkStart = index;
      continue;
    }

    if (clipped) {
      index++;
      chunkStart = index;
      continue;
    }

    if (bytes[index] === 0x09) {
      const tabColumn = expandTabsInOutput ? column - startColumn : column;
      const advance = tabSize - (tabColumn % tabSize);
      if (column + advance >= endColumn) {
        if (chunkStart < index) {
          await writer.writeBytes({ bytes: bytes.subarray(chunkStart, index) });
        }
        if (expandTabsInOutput && column < endColumn) {
          await writer.writeText({ text: ' '.repeat(endColumn - column) });
          column = endColumn;
        }
        index++;
        chunkStart = index;
        clipped = true;
        continue;
      }
      if (chunkStart < index) {
        await writer.writeBytes({ bytes: bytes.subarray(chunkStart, index) });
      }
      if (expandTabsInOutput) {
        await writer.writeText({ text: ' '.repeat(advance) });
      } else {
        await writer.writeBytes({ bytes: bytes.subarray(index, index + 1) });
      }
      column += advance;
      index++;
      chunkStart = index;
      continue;
    }

    const sequenceLength = outputOptionsCharacterWidth({ bytes, index, characterLocaleMode });
    if (column + sequenceLength.columnWidth > endColumn
      || (sequenceLength.columnWidth > 0 && column >= endColumn)) {
      if (chunkStart < index) {
        await writer.writeBytes({ bytes: bytes.subarray(chunkStart, index) });
      }
      index += sequenceLength.byteLength;
      chunkStart = index;
      clipped = true;
      continue;
    }
    index += sequenceLength.byteLength;
    column += sequenceLength.columnWidth;
  }

  if (chunkStart < index) {
    await writer.writeBytes({ bytes: bytes.subarray(chunkStart, index) });
  }
  return column;
}

function padSideBySideToColumn({
  currentColumn,
  targetColumn,
  tabSize,
  useTabs,
}: {
  currentColumn: number,
  targetColumn: number,
  tabSize: number,
  useTabs: boolean,
}): { text: string, endColumn: number } {
  let text = '';
  let column = currentColumn;
  while (useTabs) {
    const nextTabStop = column + (tabSize - (column % tabSize));
    if (nextTabStop > targetColumn) break;
    text += '\t';
    column = nextTabStop;
  }
  if (column < targetColumn) {
    text += ' '.repeat(targetColumn - column);
    column = targetColumn;
  }
  return { text, endColumn: column };
}

type SideBySideMarker = ' ' | '|' | '<' | '>' | '(' | ')' | '/' | '\\';

function isCommonSideBySideMarker({
  marker,
}: {
  marker: SideBySideMarker,
}): boolean {
  switch (marker) {
  case ' ': return true;
  case '|':
  case '<':
  case '>':
  case '(':
  case ')':
  case '/':
  case '\\': return false;
  default: {
    const _ex: never = marker;
    throw new Error(`Unhandled side-by-side marker: ${_ex}`);
  }
  }
}

function hasRightSideBySideColumn({
  marker,
}: {
  marker: SideBySideMarker,
}): boolean {
  switch (marker) {
  case ' ':
  case '|':
  case '>':
  case ')':
  case '/':
  case '\\': return true;
  case '<':
  case '(': return false;
  default: {
    const _ex: never = marker;
    throw new Error(`Unhandled side-by-side marker: ${_ex}`);
  }
  }
}

async function writeSideBySideRow({
  writer,
  leftBytes,
  marker,
  rightBytes,
  width,
  outputOptions,
  terminateLine = true,
}: {
  writer: DiffByteWriter,
  leftBytes: Uint8Array,
  marker: SideBySideMarker,
  rightBytes: Uint8Array,
  width: number,
  outputOptions: DiffOutputOptions,
  terminateLine?: boolean,
}): Promise<void> {
  const rowTerminator = terminateLine ? '\n' : '';
  if (isCommonSideBySideMarker({ marker }) && leftBytes.byteLength === 0 && rightBytes.byteLength === 0) {
    await writer.writeText({ text: rowTerminator });
    return;
  }
  const layout = resolveSideBySideLayout({
    width,
    tabSize: outputOptions.tabSize,
    expandTabsInOutput: outputOptions.expandTabs,
  });
  if (layout.halfWidth === 0) {
    const leftEndColumn = await writeSideBySideColumn({
      writer,
      bytes: leftBytes,
      startColumn: 0,
      width: 0,
      tabSize: outputOptions.tabSize,
      expandTabsInOutput: outputOptions.expandTabs,
      characterLocaleMode: outputOptions.characterLocaleMode,
    });
    if (isCommonSideBySideMarker({ marker })) {
      const padding = padSideBySideToColumn({
        currentColumn: leftEndColumn,
        targetColumn: width,
        tabSize: outputOptions.tabSize,
        useTabs: !outputOptions.expandTabs,
      });
      await writer.writeText({ text: padding.text });
      await writeSideBySideColumn({
        writer,
        bytes: rightBytes,
        startColumn: width,
        width: 0,
        tabSize: outputOptions.tabSize,
        expandTabsInOutput: outputOptions.expandTabs,
        characterLocaleMode: outputOptions.characterLocaleMode,
      });
      await writer.writeText({ text: rowTerminator });
      return;
    }
    const beforeMarker = padSideBySideToColumn({
      currentColumn: leftEndColumn,
      targetColumn: layout.markerColumn,
      tabSize: outputOptions.tabSize,
      useTabs: !outputOptions.expandTabs,
    });
    await writer.writeText({ text: `${beforeMarker.text}${marker}` });
    if (!hasRightSideBySideColumn({ marker }) || rightBytes.byteLength === 0) {
      await writer.writeText({ text: rowTerminator });
      return;
    }
    const afterMarker = padSideBySideToColumn({
      currentColumn: layout.markerColumn + 1,
      targetColumn: width,
      tabSize: outputOptions.tabSize,
      useTabs: !outputOptions.expandTabs,
    });
    await writer.writeText({ text: afterMarker.text });
    await writeSideBySideColumn({
      writer,
      bytes: rightBytes,
      startColumn: width,
      width: 0,
      tabSize: outputOptions.tabSize,
      expandTabsInOutput: outputOptions.expandTabs,
      characterLocaleMode: outputOptions.characterLocaleMode,
    });
    await writer.writeText({ text: rowTerminator });
    return;
  }

  const leftEndColumn = await writeSideBySideColumn({
    writer,
    bytes: leftBytes,
    startColumn: 0,
    width: layout.halfWidth,
    tabSize: outputOptions.tabSize,
    expandTabsInOutput: outputOptions.expandTabs,
    characterLocaleMode: outputOptions.characterLocaleMode,
  });
  if (isCommonSideBySideMarker({ marker })) {
    const betweenColumns = padSideBySideToColumn({
      currentColumn: leftEndColumn,
      targetColumn: layout.column2Offset,
      tabSize: outputOptions.tabSize,
      useTabs: !outputOptions.expandTabs,
    });
    await writer.writeText({ text: betweenColumns.text });
    await writeSideBySideColumn({
      writer,
      bytes: rightBytes,
      startColumn: layout.column2Offset,
      width: layout.halfWidth,
      tabSize: outputOptions.tabSize,
      expandTabsInOutput: outputOptions.expandTabs,
      characterLocaleMode: outputOptions.characterLocaleMode,
    });
    await writer.writeText({ text: rowTerminator });
    return;
  }

  const beforeMarker = padSideBySideToColumn({
    currentColumn: leftEndColumn,
    targetColumn: layout.markerColumn,
    tabSize: outputOptions.tabSize,
    useTabs: !outputOptions.expandTabs,
  });
  await writer.writeText({ text: `${beforeMarker.text}${marker}` });
  if (!hasRightSideBySideColumn({ marker }) || rightBytes.byteLength === 0) {
    await writer.writeText({ text: rowTerminator });
    return;
  }
  const afterMarker = padSideBySideToColumn({
    currentColumn: layout.markerColumn + 1,
    targetColumn: layout.column2Offset,
    tabSize: outputOptions.tabSize,
    useTabs: !outputOptions.expandTabs,
  });
  await writer.writeText({ text: afterMarker.text });
  await writeSideBySideColumn({
    writer,
    bytes: rightBytes,
    startColumn: layout.column2Offset,
    width: layout.halfWidth,
    tabSize: outputOptions.tabSize,
    expandTabsInOutput: outputOptions.expandTabs,
    characterLocaleMode: outputOptions.characterLocaleMode,
  });
  await writer.writeText({ text: rowTerminator });
}

async function writeSideBySide({
  writer,
  left,
  right,
  operations,
  ignoredGroups,
  comparisonOptions,
  outputOptions,
  width,
  commonLineMode,
}: {
  writer: DiffByteWriter,
  left: DiffInput,
  right: DiffInput,
  operations: readonly DiffOperation[],
  ignoredGroups: readonly DiffChangeGroup[],
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
  width: number,
  commonLineMode: 'both' | 'left-only' | 'suppress',
}): Promise<void> {
  const ignoredOperationStarts = new Set(ignoredGroups.map((group) => group.operationStart));
  let operationIndex = 0;
  let equalPrefixSkip = 0;
  while (operationIndex < operations.length) {
    const operation = operations[operationIndex];
    if (operation === undefined) {
      break;
    }
    if (isEqualOperation({ operation })) {
      const presentation = resolveCommonLinePresentation({ mode: commonLineMode });
      if (presentation.shouldWrite) {
        for (let offset = equalPrefixSkip; offset < operation.length; offset++) {
          const leftBytes = getLineBytes({ input: left, lineIndex: operation.leftStart + offset, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn });
          const rightBytes = presentation.includeRight
            ? getLineBytes({ input: right, lineIndex: operation.rightStart + offset, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn })
            : EMPTY_BYTES;
          await writeSideBySideRow({
            writer,
            leftBytes,
            marker: presentation.marker,
            rightBytes,
            width,
            outputOptions,
            terminateLine: left.lines.hasLineFeed[operation.leftStart + offset] === 1,
          });
        }
      }
      equalPrefixSkip = 0;
      operationIndex++;
      continue;
    }

    const blockStart = operationIndex;
    const deleted: number[] = [];
    const inserted: number[] = [];
    while (operationIndex < operations.length) {
      const current = operations[operationIndex];
      if (current === undefined || isEqualOperation({ operation: current })) {
        break;
      }
      switch (current.kind) {
      case 'delete':
        for (let offset = 0; offset < current.length; offset++) deleted.push(current.leftStart + offset);
        break;
      case 'insert':
        for (let offset = 0; offset < current.length; offset++) inserted.push(current.rightStart + offset);
        break;
      case 'equal': break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }
      operationIndex++;
    }

    if (ignoredOperationStarts.has(blockStart)) {
      switch (commonLineMode) {
      case 'suppress':
        continue;
      case 'left-only':
        for (const leftIndex of deleted) {
          await writeSideBySideRow({
            writer,
            leftBytes: getLineBytes({ input: left, lineIndex: leftIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
            marker: '(',
            rightBytes: EMPTY_BYTES,
            width,
            outputOptions,
          });
        }
        continue;
      case 'both':
        break;
      default: {
        const _ex: never = commonLineMode;
        throw new Error(`Unhandled side-by-side common line mode: ${_ex}`);
      }
      }

      const pairedCount = Math.min(deleted.length, inserted.length);
      for (let row = 0; row < pairedCount; row++) {
        const leftIndex = deleted[row];
        const rightIndex = inserted[row];
        if (leftIndex === undefined || rightIndex === undefined) {
          continue;
        }
        await writeSideBySideRow({
          writer,
          leftBytes: getLineBytes({ input: left, lineIndex: leftIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
          marker: ' ',
          rightBytes: getLineBytes({ input: right, lineIndex: rightIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
          width,
          outputOptions,
        });
      }

      const nextOperation = operations[operationIndex];
      const nextEqual = nextOperation !== undefined && isEqualOperation({ operation: nextOperation })
        ? nextOperation
        : undefined;
      if (deleted.length > inserted.length) {
        const remainingCount = deleted.length - pairedCount;
        const borrowCount = Math.min(remainingCount, nextEqual?.length ?? 0);
        for (let offset = 0; offset < borrowCount; offset++) {
          const leftIndex = deleted[pairedCount + offset];
          if (leftIndex === undefined || nextEqual === undefined) {
            continue;
          }
          await writeSideBySideRow({
            writer,
            leftBytes: getLineBytes({ input: left, lineIndex: leftIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
            marker: ' ',
            rightBytes: getLineBytes({ input: right, lineIndex: nextEqual.rightStart + offset, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
            width,
            outputOptions,
          });
        }
        for (let offset = borrowCount; offset < remainingCount; offset++) {
          const leftIndex = deleted[pairedCount + offset];
          if (leftIndex === undefined) {
            continue;
          }
          await writeSideBySideRow({
            writer,
            leftBytes: getLineBytes({ input: left, lineIndex: leftIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
            marker: '(',
            rightBytes: EMPTY_BYTES,
            width,
            outputOptions,
          });
        }
        if (nextEqual !== undefined) {
          for (let offset = 0; offset < borrowCount; offset++) {
            await writeSideBySideRow({
              writer,
              leftBytes: getLineBytes({ input: left, lineIndex: nextEqual.leftStart + offset, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
              marker: '(',
              rightBytes: EMPTY_BYTES,
              width,
              outputOptions,
            });
          }
        }
        equalPrefixSkip = borrowCount;
        continue;
      }

      if (inserted.length > deleted.length) {
        const remainingCount = inserted.length - pairedCount;
        const borrowCount = Math.min(remainingCount, nextEqual?.length ?? 0);
        for (let offset = 0; offset < borrowCount; offset++) {
          const rightIndex = inserted[pairedCount + offset];
          if (rightIndex === undefined || nextEqual === undefined) {
            continue;
          }
          await writeSideBySideRow({
            writer,
            leftBytes: getLineBytes({ input: left, lineIndex: nextEqual.leftStart + offset, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
            marker: ' ',
            rightBytes: getLineBytes({ input: right, lineIndex: rightIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
            width,
            outputOptions,
          });
        }
        for (let offset = borrowCount; offset < remainingCount; offset++) {
          const rightIndex = inserted[pairedCount + offset];
          if (rightIndex === undefined) {
            continue;
          }
          await writeSideBySideRow({
            writer,
            leftBytes: EMPTY_BYTES,
            marker: ')',
            rightBytes: getLineBytes({ input: right, lineIndex: rightIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
            width,
            outputOptions,
          });
        }
        if (nextEqual !== undefined) {
          for (let offset = 0; offset < borrowCount; offset++) {
            await writeSideBySideRow({
              writer,
              leftBytes: EMPTY_BYTES,
              marker: ')',
              rightBytes: getLineBytes({ input: right, lineIndex: nextEqual.rightStart + offset, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn }),
              width,
              outputOptions,
            });
          }
        }
        equalPrefixSkip = borrowCount;
        continue;
      }

      continue;
    }

    const rowCount = Math.max(deleted.length, inserted.length);
    for (let row = 0; row < rowCount; row++) {
      const leftIndex = deleted[row];
      const rightIndex = inserted[row];
      const leftBytes = leftIndex === undefined ? EMPTY_BYTES : getLineBytes({ input: left, lineIndex: leftIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn });
      const rightBytes = rightIndex === undefined ? EMPTY_BYTES : getLineBytes({ input: right, lineIndex: rightIndex, stripTrailingCarriageReturn: comparisonOptions.stripTrailingCarriageReturn });
      const leftHasLineFeed = leftIndex !== undefined && left.lines.hasLineFeed[leftIndex] === 1;
      const rightHasLineFeed = rightIndex !== undefined && right.lines.hasLineFeed[rightIndex] === 1;
      const marker: SideBySideMarker = leftIndex === undefined
        ? '>'
        : rightIndex === undefined
          ? '<'
          : leftHasLineFeed === rightHasLineFeed
            ? '|'
            : leftHasLineFeed
              ? '/'
              : '\\';
      await writeSideBySideRow({
        writer,
        leftBytes,
        marker,
        rightBytes,
        width,
        outputOptions,
        terminateLine: leftHasLineFeed || rightHasLineFeed,
      });
    }
  }
}

async function writeIfdef({
  writer,
  left,
  right,
  operations,
  ignoredGroups,
  comparisonOptions,
  outputOptions,
  name,
}: {
  writer: DiffByteWriter,
  left: DiffInput,
  right: DiffInput,
  operations: readonly DiffOperation[],
  ignoredGroups: readonly DiffChangeGroup[],
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
  name: string,
}): Promise<void> {
  const ignoredOperationStarts = new Set(ignoredGroups.map((group) => group.operationStart));
  let operationIndex = 0;
  while (operationIndex < operations.length) {
    const operation = operations[operationIndex];
    if (operation === undefined) break;
    if (isEqualOperation({ operation })) {
      for (let offset = 0; offset < operation.length; offset++) {
        await writeScriptInputLine({
          writer,
          input: left,
          lineIndex: operation.leftStart + offset,
          comparisonOptions,
          outputOptions,
          forceLineFeed: true,
          escapeEdTerminator: false,
        });
      }
      operationIndex++;
      continue;
    }

    const blockStart = operationIndex;
    let hasDelete = false;
    let hasInsert = false;
    while (operationIndex < operations.length) {
      const current = operations[operationIndex];
      if (current === undefined || isEqualOperation({ operation: current })) break;
      switch (current.kind) {
      case 'delete': hasDelete = true; break;
      case 'insert': hasInsert = true; break;
      case 'equal': break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }
      operationIndex++;
    }

    if (ignoredOperationStarts.has(blockStart)) {
      for (let index = blockStart; index < operationIndex; index++) {
        const current = operations[index];
        if (current === undefined) continue;
        switch (current.kind) {
        case 'delete':
          for (let offset = 0; offset < current.length; offset++) {
            await writeScriptInputLine({
              writer,
              input: left,
              lineIndex: current.leftStart + offset,
              comparisonOptions,
              outputOptions,
              forceLineFeed: true,
              escapeEdTerminator: false,
            });
          }
          break;
        case 'insert':
        case 'equal':
          break;
        default: {
          const _ex: never = current;
          throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
        }
        }
      }
      continue;
    }

    if (hasDelete) await writer.writeText({ text: `#ifndef ${name}\n` });
    else await writer.writeText({ text: `#ifdef ${name}\n` });

    for (let index = blockStart; index < operationIndex; index++) {
      const current = operations[index];
      if (current === undefined) continue;
      switch (current.kind) {
      case 'delete':
        for (let offset = 0; offset < current.length; offset++) {
          await writeScriptInputLine({
            writer,
            input: left,
            lineIndex: current.leftStart + offset,
            comparisonOptions,
            outputOptions,
            forceLineFeed: true,
            escapeEdTerminator: false,
          });
        }
        break;
      case 'equal':
      case 'insert': break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }
    }

    if (hasDelete && hasInsert) await writer.writeText({ text: `#else /* ${name} */\n` });

    for (let index = blockStart; index < operationIndex; index++) {
      const current = operations[index];
      if (current === undefined) continue;
      switch (current.kind) {
      case 'insert':
        for (let offset = 0; offset < current.length; offset++) {
          await writeScriptInputLine({
            writer,
            input: right,
            lineIndex: current.rightStart + offset,
            comparisonOptions,
            outputOptions,
            forceLineFeed: true,
            escapeEdTerminator: false,
          });
        }
        break;
      case 'equal':
      case 'delete': break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }
    }

    await writer.writeText({ text: `#endif /* ${hasDelete && !hasInsert ? `! ${name}` : name} */\n` });
  }
}

export async function writeDiffOutput({
  writer,
  left,
  right,
  operations,
  changeGroups,
  ignoredGroups,
  comparisonOptions,
  outputOptions,
}: {
  writer: DiffByteWriter,
  left: DiffInput,
  right: DiffInput,
  operations: readonly DiffOperation[],
  changeGroups: readonly DiffChangeGroup[],
  ignoredGroups: readonly DiffChangeGroup[],
  comparisonOptions: DiffComparisonOptions,
  outputOptions: DiffOutputOptions,
}): Promise<void> {
  switch (outputOptions.mode.kind) {
  case 'normal':
    await writeNormal({ writer, left, right, changeGroups, comparisonOptions, outputOptions });
    break;
  case 'unified':
    await writeUnified({ writer, left, right, operations, changeGroups, comparisonOptions, outputOptions, contextLines: outputOptions.mode.contextLines });
    break;
  case 'context':
    await writeContext({ writer, left, right, operations, changeGroups, comparisonOptions, outputOptions, contextLines: outputOptions.mode.contextLines });
    break;
  case 'ed':
    await writeEd({ writer, right, changeGroups, comparisonOptions, outputOptions });
    break;
  case 'rcs':
    await writeRcs({ writer, right, changeGroups, comparisonOptions, outputOptions });
    break;
  case 'side-by-side':
    await writeSideBySide({
      writer,
      left,
      right,
      operations,
      ignoredGroups,
      comparisonOptions,
      outputOptions,
      width: outputOptions.mode.width,
      commonLineMode: outputOptions.mode.commonLineMode,
    });
    break;
  case 'ifdef':
    await writeIfdef({ writer, left, right, operations, ignoredGroups, comparisonOptions, outputOptions, name: outputOptions.mode.name });
    break;
  case 'brief':
    throw new Error('brief output is handled before detailed formatting');
  default: {
    const _ex: never = outputOptions.mode;
    throw new Error(`Unhandled diff output mode: ${JSON.stringify(_ex)}`);
  }
  }
  await writer.flush();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  formatContextTimestamp,
  formatNormalRange,
  formatUnifiedRange,
};
