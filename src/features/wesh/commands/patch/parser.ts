import type {
  EdCommand,
  ParsedPatchDocument,
  PatchFileKind,
  PatchFormat,
  PatchLine,
  PatchRange,
  PatchSection,
  PatchSectionHeader,
  TextHunk,
  TextPatchSection,
} from './types';

interface InputLine {
  content: Uint8Array,
  lineNumber: number,
}

interface ContextBlockLine {
  kind: 'context' | 'change' | 'remove' | 'add',
  content: Uint8Array,
  terminator: PatchLine['terminator'],
}

const decoder = new TextDecoder();
const pathDecoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function bytesEqual({ left, right }: { left: Uint8Array, right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeLine({ line }: { line: InputLine }): string {
  const content = line.content[line.content.byteLength - 1] === 0x0d
    ? line.content.subarray(0, line.content.byteLength - 1)
    : line.content;
  return decoder.decode(content);
}

function splitInputLines({
  bytes,
  stripCarriageReturns,
}: {
  bytes: Uint8Array,
  stripCarriageReturns: boolean,
}): { lines: InputLine[], strippedCarriageReturns: boolean } {
  const lines: InputLine[] = [];
  let start = 0;
  let lineNumber = 1;
  let strippedCarriageReturns = false;

  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0x0a) continue;

    let end = index;
    if (stripCarriageReturns && end > start && bytes[end - 1] === 0x0d) {
      end -= 1;
      strippedCarriageReturns = true;
    }

    lines.push({ content: bytes.subarray(start, end), lineNumber });
    start = index + 1;
    lineNumber += 1;
  }

  if (start < bytes.byteLength) {
    lines.push({ content: bytes.subarray(start), lineNumber });
  }

  return { lines, strippedCarriageReturns };
}

function consumePatchLineTerminator({
  lines,
  nextIndex,
}: {
  lines: InputLine[],
  nextIndex: number,
}): { terminator: PatchLine['terminator'], nextIndex: number } {
  const marker = lines[nextIndex];
  if (marker !== undefined && decodeLine({ line: marker }) === '\\ No newline at end of file') {
    return { terminator: 'none', nextIndex: nextIndex + 1 };
  }
  return { terminator: 'lf', nextIndex };
}

function createEmptyHeader(): PatchSectionHeader {
  return {
    oldPath: undefined,
    newPath: undefined,
    indexPath: undefined,
    operation: 'modify',
    oldKind: 'regular',
    newKind: 'regular',
    oldMode: undefined,
    newMode: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    copyFrom: undefined,
    copyTo: undefined,
    gitBinary: false,
  };
}

function parseMode({ value }: { value: string }): { mode: number, kind: PatchFileKind } {
  if (!/^[0-7]{6}$/u.test(value)) {
    throw new Error(`invalid Git file mode '${value}'`);
  }

  const rawMode = Number.parseInt(value, 8);
  const kind = (() => {
    switch (value.slice(0, 3)) {
    case '100':
      return 'regular' as const;
    case '120':
      return 'symlink' as const;
    default:
      throw new Error(`unsupported Git file mode '${value}'`);
    }
  })();
  const permissions = rawMode & 0o7777;
  return { mode: kind === 'symlink' && permissions === 0 ? 0o777 : permissions, kind };
}

function decodeGitQuotedPath({ value }: { value: string }): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error(`unterminated quoted path ${value}`);

  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index];
    if (character !== '\\') {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) throw new Error(`invalid character in path ${value}`);
      const decodedCharacter = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(decodedCharacter));
      index += decodedCharacter.length - 1;
      continue;
    }

    index += 1;
    const escaped = value[index];
    if (escaped === undefined) throw new Error(`unterminated escape in path ${value}`);

    switch (escaped) {
    case '\\':
    case '"':
      bytes.push(escaped.charCodeAt(0));
      break;
    case 't':
      bytes.push(0x09);
      break;
    case 'n':
      bytes.push(0x0a);
      break;
    case 'r':
      bytes.push(0x0d);
      break;
    default: {
      if (!/[0-7]/u.test(escaped)) {
        bytes.push(...encoder.encode(escaped));
        break;
      }

      let octal = escaped;
      for (let count = 0; count < 2; count++) {
        const next = value[index + 1];
        if (next === undefined || !/[0-7]/u.test(next)) break;
        index += 1;
        octal += next;
      }
      bytes.push(Number.parseInt(octal, 8));
      break;
    }
    }
  }

  if (bytes.includes(0)) throw new Error('patch path contains a NUL byte');
  try {
    return pathDecoder.decode(new Uint8Array(bytes));
  } catch {
    throw new Error(`Git path is not valid UTF-8: ${value}`);
  }
}

function parseGitTokens({ value }: { value: string }): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < value.length) {
    while (value[index] === ' ') index += 1;
    if (index >= value.length) break;

    if (value[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < value.length) {
        const character = value[index];
        if (!escaped && character === '"') {
          index += 1;
          break;
        }
        if (!escaped && character === '\\') {
          escaped = true;
        } else {
          escaped = false;
        }
        index += 1;
      }
      tokens.push(decodeGitQuotedPath({ value: value.slice(start, index) }));
      continue;
    }

    const start = index;
    while (index < value.length && value[index] !== ' ') index += 1;
    tokens.push(value.slice(start, index));
  }

  return tokens;
}

function trimAsciiHorizontalWhitespace({ value }: { value: string }): string {
  return value.replace(/^[ \t]+|[ \t]+$/gu, '');
}

function parseHeaderPath({ value }: { value: string }): string {
  const trimmed = value.replace(/^[ \t]+/u, '');
  if (trimmed.startsWith('"')) {
    let index = 1;
    let escaped = false;
    while (index < trimmed.length) {
      const character = trimmed[index];
      if (!escaped && character === '"') {
        return decodeGitQuotedPath({ value: trimmed.slice(0, index + 1) });
      }
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      index += 1;
    }
    throw new Error(`unterminated quoted path ${trimmed}`);
  }

  const tabIndex = trimmed.indexOf('\t');
  return trimAsciiHorizontalWhitespace({
    value: tabIndex >= 0 ? trimmed.slice(0, tabIndex) : trimmed,
  });
}

function parseRange({ startText, countText }: { startText: string, countText: string | undefined }): PatchRange {
  const start = Number(startText);
  const count = countText === undefined ? 1 : Number(countText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0) {
    throw new Error(`invalid hunk range '${startText},${countText ?? '1'}'`);
  }
  return { start, count };
}

function parseUnifiedHunk({
  lines,
  startIndex,
}: {
  lines: InputLine[],
  startIndex: number,
}): { hunk: TextHunk, nextIndex: number } {
  const headerLine = lines[startIndex];
  if (headerLine === undefined) throw new Error('missing unified hunk header');
  const headerText = decodeLine({ line: headerLine });
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/u.exec(headerText);
  if (match === null) throw new Error(`malformed unified hunk header at line ${headerLine.lineNumber}`);

  const oldRange = parseRange({ startText: match[1]!, countText: match[2] });
  const newRange = parseRange({ startText: match[3]!, countText: match[4] });
  const hunkLines: PatchLine[] = [];
  let oldCount = 0;
  let newCount = 0;
  let index = startIndex + 1;

  while (index < lines.length && (oldCount < oldRange.count || newCount < newRange.count)) {
    const line = lines[index]!;
    const prefix = line.content[0];

    if (prefix === 0x5c) {
      throw new Error(`unexpected no-newline marker at line ${line.lineNumber}`);
    }

    const kind = (() => {
      switch (prefix) {
      case 0x20:
        return 'context' as const;
      case 0x2d:
        return 'remove' as const;
      case 0x2b:
        return 'add' as const;
      default:
        throw new Error(`malformed unified hunk line at line ${line.lineNumber}`);
      }
    })();

    switch (kind) {
    case 'context':
      oldCount += 1;
      newCount += 1;
      break;
    case 'remove':
      oldCount += 1;
      break;
    case 'add':
      newCount += 1;
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled patch line kind: ${_ex}`);
    }
    }
    if (oldCount > oldRange.count || newCount > newRange.count) {
      throw new Error(`hunk body exceeds declared range at line ${line.lineNumber}`);
    }

    hunkLines.push({ kind, content: line.content.subarray(1), terminator: 'lf' });
    index += 1;

    const markerLine = lines[index];
    if (markerLine !== undefined && decodeLine({ line: markerLine }) === '\\ No newline at end of file') {
      const previous = hunkLines[hunkLines.length - 1];
      if (previous === undefined) throw new Error(`orphan no-newline marker at line ${markerLine.lineNumber}`);
      previous.terminator = 'none';
      index += 1;
    }
  }

  if (oldCount !== oldRange.count || newCount !== newRange.count) {
    throw new Error(`truncated unified hunk at line ${headerLine.lineNumber}`);
  }

  return {
    hunk: {
      oldRange,
      newRange,
      heading: match[5],
      lines: hunkLines,
      sourceLineNumber: headerLine.lineNumber,
    },
    nextIndex: index,
  };
}

function parseUnifiedSection({
  lines,
  startIndex,
}: {
  lines: InputLine[],
  startIndex: number,
}): { section: TextPatchSection, nextIndex: number } {
  const header = createEmptyHeader();
  const sourceLineNumber = lines[startIndex]?.lineNumber ?? 1;
  let index = startIndex;
  let sawTraditionalHeader = false;
  let sawGitHeader = false;

  const firstText = decodeLine({ line: lines[index]! });
  if (firstText.startsWith('diff --git ')) {
    const tokens = parseGitTokens({ value: firstText.slice('diff --git '.length) });
    if (tokens.length !== 2) {
      throw new Error(`malformed diff --git header at line ${sourceLineNumber}`);
    }
    header.oldPath = tokens[0];
    header.newPath = tokens[1];
    sawGitHeader = true;
    index += 1;
  }

  while (index < lines.length) {
    const line = lines[index]!;
    const text = decodeLine({ line });

    if (text.startsWith('diff --git ') && index !== startIndex) break;
    if (text.startsWith('Index: ')) {
      header.indexPath = trimAsciiHorizontalWhitespace({
        value: text.slice('Index: '.length),
      });
      index += 1;
      continue;
    }
    if (text.startsWith('new file mode ')) {
      const parsed = parseMode({ value: text.slice('new file mode '.length).trim() });
      header.operation = 'create';
      header.newMode = parsed.mode;
      header.newKind = parsed.kind;
      index += 1;
      continue;
    }
    if (text.startsWith('deleted file mode ')) {
      const parsed = parseMode({ value: text.slice('deleted file mode '.length).trim() });
      header.operation = 'delete';
      header.oldMode = parsed.mode;
      header.oldKind = parsed.kind;
      index += 1;
      continue;
    }
    if (text.startsWith('old mode ')) {
      const parsed = parseMode({ value: text.slice('old mode '.length).trim() });
      header.oldMode = parsed.mode;
      header.oldKind = parsed.kind;
      index += 1;
      continue;
    }
    if (text.startsWith('new mode ')) {
      const parsed = parseMode({ value: text.slice('new mode '.length).trim() });
      header.newMode = parsed.mode;
      header.newKind = parsed.kind;
      index += 1;
      continue;
    }
    if (text.startsWith('rename from ')) {
      header.operation = 'rename';
      header.renameFrom = decodeGitQuotedPath({ value: text.slice('rename from '.length) });
      index += 1;
      continue;
    }
    if (text.startsWith('rename to ')) {
      header.operation = 'rename';
      header.renameTo = decodeGitQuotedPath({ value: text.slice('rename to '.length) });
      index += 1;
      continue;
    }
    if (text.startsWith('copy from ')) {
      header.operation = 'copy';
      header.copyFrom = decodeGitQuotedPath({ value: text.slice('copy from '.length) });
      index += 1;
      continue;
    }
    if (text.startsWith('copy to ')) {
      header.operation = 'copy';
      header.copyTo = decodeGitQuotedPath({ value: text.slice('copy to '.length) });
      index += 1;
      continue;
    }
    if (text === 'GIT binary patch' || text.startsWith('Binary files ')) {
      header.gitBinary = true;
      index += 1;
      while (index < lines.length && !decodeLine({ line: lines[index]! }).startsWith('diff --git ')) index += 1;
      break;
    }
    if (text.startsWith('--- ')) {
      header.oldPath = parseHeaderPath({ value: text.slice(4) });
      const newHeaderLine = lines[index + 1];
      if (newHeaderLine === undefined || !decodeLine({ line: newHeaderLine }).startsWith('+++ ')) {
        throw new Error(`missing +++ header after line ${line.lineNumber}`);
      }
      header.newPath = parseHeaderPath({ value: decodeLine({ line: newHeaderLine }).slice(4) });
      if (header.oldPath === '/dev/null') header.operation = 'create';
      if (header.newPath === '/dev/null') header.operation = 'delete';
      sawTraditionalHeader = true;
      index += 2;
      break;
    }
    if (text.startsWith('@@ ')) break;
    index += 1;
  }

  const hunks: TextHunk[] = [];
  while (index < lines.length) {
    const text = decodeLine({ line: lines[index]! });
    if (text.startsWith('diff --git ')) break;
    if (text.startsWith('--- ') && hunks.length > 0) break;
    if (!text.startsWith('@@ ')) {
      if (sawTraditionalHeader && (text.startsWith('*** ') || /^\d+(?:,\d+)?[acd]\d/u.test(text))) break;
      index += 1;
      continue;
    }

    const parsedHunk = parseUnifiedHunk({ lines, startIndex: index });
    hunks.push(parsedHunk.hunk);
    index = parsedHunk.nextIndex;
  }

  if (!sawTraditionalHeader && hunks.length > 0 && header.oldPath === undefined && header.newPath === undefined) {
    throw new Error(`unified patch at line ${sourceLineNumber} has no file header`);
  }

  if (sawTraditionalHeader && !sawGitHeader && hunks.length === 0) {
    throw new Error(`unified patch at line ${sourceLineNumber} has no hunks`);
  }

  return {
    section: {
      kind: 'text',
      format: 'unified',
      header,
      hunks,
      sourceLineNumber,
    },
    nextIndex: index,
  };
}

function parseContextRange({ text, marker }: { text: string, marker: 'old' | 'new' }): PatchRange {
  const expression = (() => {
    switch (marker) {
    case 'old':
      return /^\*\*\* (\d+)(?:,(\d+))? \*\*\*\*$/u;
    case 'new':
      return /^--- (\d+)(?:,(\d+))? ----$/u;
    default: {
      const _ex: never = marker;
      throw new Error(`Unhandled context range marker: ${_ex}`);
    }
    }
  })();
  const match = expression.exec(text);
  if (match === null) throw new Error(`malformed context ${marker} range '${text}'`);
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error(`invalid context ${marker} range '${text}'`);
  }
  if (start === 0 && end === 0) return { start: 0, count: 0 };
  return { start, count: end - start + 1 };
}

function convertContextBlocks({
  oldBlock,
  newBlock,
  lineNumber,
}: {
  oldBlock: ContextBlockLine[],
  newBlock: ContextBlockLine[],
  lineNumber: number,
}): PatchLine[] {
  const result: PatchLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldBlock.length || newIndex < newBlock.length) {
    const oldLine = oldBlock[oldIndex];
    const newLine = newBlock[newIndex];

    if (oldLine?.kind === 'context' && newLine?.kind === 'context') {
      if (!bytesEqual({ left: oldLine.content, right: newLine.content })) {
        throw new Error(`context lines disagree near line ${lineNumber}`);
      }
      if (oldLine.terminator !== newLine.terminator) {
        throw new Error(`context line terminators disagree near line ${lineNumber}`);
      }
      result.push({ kind: 'context', content: oldLine.content, terminator: oldLine.terminator });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    while (oldIndex < oldBlock.length && oldBlock[oldIndex]?.kind !== 'context') {
      result.push({
        kind: 'remove',
        content: oldBlock[oldIndex]!.content,
        terminator: oldBlock[oldIndex]!.terminator,
      });
      oldIndex += 1;
    }
    while (newIndex < newBlock.length && newBlock[newIndex]?.kind !== 'context') {
      result.push({
        kind: 'add',
        content: newBlock[newIndex]!.content,
        terminator: newBlock[newIndex]!.terminator,
      });
      newIndex += 1;
    }

    if ((oldBlock[oldIndex]?.kind === 'context') !== (newBlock[newIndex]?.kind === 'context')) {
      throw new Error(`context hunk is not synchronized near line ${lineNumber}`);
    }
  }

  return result;
}

function parseContextSection({
  lines,
  startIndex,
}: {
  lines: InputLine[],
  startIndex: number,
}): { section: TextPatchSection, nextIndex: number } {
  const oldHeaderLine = lines[startIndex]!;
  const newHeaderLine = lines[startIndex + 1];
  if (newHeaderLine === undefined || !decodeLine({ line: newHeaderLine }).startsWith('--- ')) {
    throw new Error(`missing context new-file header after line ${oldHeaderLine.lineNumber}`);
  }

  const header = createEmptyHeader();
  header.oldPath = parseHeaderPath({ value: decodeLine({ line: oldHeaderLine }).slice(4) });
  header.newPath = parseHeaderPath({ value: decodeLine({ line: newHeaderLine }).slice(4) });
  if (header.oldPath === '/dev/null') header.operation = 'create';
  if (header.newPath === '/dev/null') header.operation = 'delete';

  let index = startIndex + 2;
  const hunks: TextHunk[] = [];

  while (index < lines.length && decodeLine({ line: lines[index]! }) === '***************') {
    const separatorLine = lines[index]!;
    const oldRangeLine = lines[index + 1];
    if (oldRangeLine === undefined) throw new Error(`truncated context hunk at line ${separatorLine.lineNumber}`);
    const oldRange = parseContextRange({ text: decodeLine({ line: oldRangeLine }), marker: 'old' });
    index += 2;

    const oldBlock: ContextBlockLine[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      const text = decodeLine({ line });
      if (/^--- \d/u.test(text)) break;
      const prefix = text.slice(0, 2);
      const kind = (() => {
        switch (prefix) {
        case '  ':
          return 'context' as const;
        case '- ':
          return 'remove' as const;
        case '! ':
          return 'change' as const;
        default:
          throw new Error(`malformed context old line at line ${line.lineNumber}`);
        }
      })();
      const consumed = consumePatchLineTerminator({ lines, nextIndex: index + 1 });
      oldBlock.push({ kind, content: line.content.subarray(2), terminator: consumed.terminator });
      index = consumed.nextIndex;
    }

    const newRangeLine = lines[index];
    if (newRangeLine === undefined) throw new Error(`missing context new range after line ${oldRangeLine.lineNumber}`);
    const newRange = parseContextRange({ text: decodeLine({ line: newRangeLine }), marker: 'new' });
    index += 1;

    const newBlock: ContextBlockLine[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      const text = decodeLine({ line });
      if (text === '***************' || text.startsWith('diff --git ') || (text.startsWith('*** ') && lines[index + 1] !== undefined && decodeLine({ line: lines[index + 1]! }).startsWith('--- '))) break;
      const prefix = text.slice(0, 2);
      const kind = (() => {
        switch (prefix) {
        case '  ':
          return 'context' as const;
        case '+ ':
          return 'add' as const;
        case '! ':
          return 'change' as const;
        default:
          throw new Error(`malformed context new line at line ${line.lineNumber}`);
        }
      })();
      const consumed = consumePatchLineTerminator({ lines, nextIndex: index + 1 });
      newBlock.push({ kind, content: line.content.subarray(2), terminator: consumed.terminator });
      index = consumed.nextIndex;
    }

    if (oldBlock.length !== oldRange.count || newBlock.length !== newRange.count) {
      throw new Error(`context hunk body does not match its declared ranges at line ${separatorLine.lineNumber}`);
    }

    hunks.push({
      oldRange,
      newRange,
      heading: undefined,
      lines: convertContextBlocks({ oldBlock, newBlock, lineNumber: separatorLine.lineNumber }),
      sourceLineNumber: separatorLine.lineNumber,
    });
  }

  if (hunks.length === 0) throw new Error(`context patch at line ${oldHeaderLine.lineNumber} has no hunks`);

  return {
    section: {
      kind: 'text',
      format: 'context',
      header,
      hunks,
      sourceLineNumber: oldHeaderLine.lineNumber,
    },
    nextIndex: index,
  };
}

function parseNormalSection({
  lines,
  startIndex,
}: {
  lines: InputLine[],
  startIndex: number,
}): { section: TextPatchSection, nextIndex: number } {
  const header = createEmptyHeader();
  const hunks: TextHunk[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const commandLine = lines[index]!;
    const match = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/u.exec(decodeLine({ line: commandLine }));
    if (match === null) break;

    const leftStart = Number(match[1]);
    const leftEnd = match[2] === undefined ? leftStart : Number(match[2]);
    const operation = match[3]!;
    const rightStart = Number(match[4]);
    const rightEnd = match[5] === undefined ? rightStart : Number(match[5]);
    if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isSafeInteger)) {
      throw new Error(`normal diff range is too large at line ${commandLine.lineNumber}`);
    }
    if (
      leftStart < 0
      || rightStart < 0
      || leftEnd < leftStart
      || rightEnd < rightStart
    ) {
      throw new Error(`invalid normal diff range at line ${commandLine.lineNumber}`);
    }
    index += 1;

    const hunkLines: PatchLine[] = [];
    if (operation === 'd' || operation === 'c') {
      const count = leftEnd - leftStart + 1;
      for (let lineIndex = 0; lineIndex < count; lineIndex++) {
        const line = lines[index];
        if (line === undefined || line.content[0] !== 0x3c || line.content[1] !== 0x20) {
          throw new Error(`missing normal diff old line near line ${commandLine.lineNumber}`);
        }
        const consumed = consumePatchLineTerminator({ lines, nextIndex: index + 1 });
        hunkLines.push({ kind: 'remove', content: line.content.subarray(2), terminator: consumed.terminator });
        index = consumed.nextIndex;
      }
    }

    if (operation === 'c') {
      const separator = lines[index];
      if (separator === undefined || decodeLine({ line: separator }) !== '---') {
        throw new Error(`missing normal diff separator near line ${commandLine.lineNumber}`);
      }
      index += 1;
    }

    if (operation === 'a' || operation === 'c') {
      const count = rightEnd - rightStart + 1;
      for (let lineIndex = 0; lineIndex < count; lineIndex++) {
        const line = lines[index];
        if (line === undefined || line.content[0] !== 0x3e || line.content[1] !== 0x20) {
          throw new Error(`missing normal diff new line near line ${commandLine.lineNumber}`);
        }
        const consumed = consumePatchLineTerminator({ lines, nextIndex: index + 1 });
        hunkLines.push({ kind: 'add', content: line.content.subarray(2), terminator: consumed.terminator });
        index = consumed.nextIndex;
      }
    }

    const oldRange = operation === 'a'
      ? { start: leftEnd, count: 0 }
      : { start: leftStart, count: leftEnd - leftStart + 1 };
    const newRange = operation === 'd'
      ? { start: rightEnd, count: 0 }
      : { start: rightStart, count: rightEnd - rightStart + 1 };

    hunks.push({
      oldRange,
      newRange,
      heading: undefined,
      lines: hunkLines,
      sourceLineNumber: commandLine.lineNumber,
    });
  }

  if (hunks.length === 0) throw new Error(`normal diff expected at line ${lines[startIndex]?.lineNumber ?? 1}`);

  return {
    section: {
      kind: 'text',
      format: 'normal',
      header,
      hunks,
      sourceLineNumber: lines[startIndex]?.lineNumber ?? 1,
    },
    nextIndex: index,
  };
}

function parseEdSection({
  lines,
  startIndex,
}: {
  lines: InputLine[],
  startIndex: number,
}): { section: PatchSection, nextIndex: number } {
  const commands: EdCommand[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const commandLine = lines[index]!;
    const match = /^(\d+)(?:,(\d+))?([acd])$/u.exec(decodeLine({ line: commandLine }));
    if (match === null) break;

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error(`invalid ed range at line ${commandLine.lineNumber}`);
    }
    index += 1;

    const operation = (() => {
      switch (match[3]) {
      case 'a':
        return 'append' as const;
      case 'c':
        return 'change' as const;
      case 'd':
        return 'delete' as const;
      default:
        throw new Error(`invalid ed operation at line ${commandLine.lineNumber}`);
      }
    })();

    const commandLines: EdCommand['lines'] = [];
    switch (operation) {
    case 'append':
    case 'change': {
      while (index < lines.length && decodeLine({ line: lines[index]! }) !== '.') {
        commandLines.push({ content: lines[index]!.content, terminator: 'lf' });
        index += 1;
      }
      if (index >= lines.length) throw new Error(`unterminated ed text block at line ${commandLine.lineNumber}`);
      index += 1;
      const dotEscapeLine = lines[index];
      if (dotEscapeLine !== undefined && decodeLine({ line: dotEscapeLine }) === 's/.//') {
        const lastLine = commandLines[commandLines.length - 1];
        if (lastLine === undefined || lastLine.content[0] !== 0x2e) {
          throw new Error(`invalid ed dot escape near line ${commandLine.lineNumber}`);
        }
        lastLine.content = lastLine.content.subarray(1);
        index += 1;
      }
      break;
    }
    case 'delete':
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled ed operation: ${_ex}`);
    }
    }

    commands.push({ start, end, operation, lines: commandLines, sourceLineNumber: commandLine.lineNumber });
  }

  if (commands.length === 0) throw new Error(`ed script expected at line ${lines[startIndex]?.lineNumber ?? 1}`);

  return {
    section: {
      kind: 'ed',
      format: 'ed',
      header: createEmptyHeader(),
      commands,
      sourceLineNumber: lines[startIndex]?.lineNumber ?? 1,
    },
    nextIndex: index,
  };
}

function looksLikeContextHeader({ lines, index }: { lines: InputLine[], index: number }): boolean {
  const first = lines[index];
  const second = lines[index + 1];
  if (first === undefined || second === undefined) return false;
  return decodeLine({ line: first }).startsWith('*** ') && decodeLine({ line: second }).startsWith('--- ');
}

function looksLikeUnifiedHeader({ lines, index }: { lines: InputLine[], index: number }): boolean {
  const first = lines[index];
  const second = lines[index + 1];
  if (first === undefined || second === undefined) return false;
  return decodeLine({ line: first }).startsWith('--- ') && decodeLine({ line: second }).startsWith('+++ ');
}

function findIndexedSection({
  lines,
  index,
}: {
  lines: InputLine[],
  index: number,
}): { format: PatchFormat, startIndex: number, indexPath: string } | undefined {
  const indexLine = lines[index];
  if (indexLine === undefined) return undefined;
  const indexText = decodeLine({ line: indexLine });
  if (!indexText.startsWith('Index: ')) return undefined;

  const indexPath = trimAsciiHorizontalWhitespace({
    value: indexText.slice('Index: '.length),
  });
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const text = decodeLine({ line: lines[cursor]! });
    if (text.startsWith('Index: ')) return undefined;
    if (text.startsWith('diff --git ') || looksLikeUnifiedHeader({ lines, index: cursor })) {
      return { format: 'unified', startIndex: cursor, indexPath };
    }
    if (looksLikeContextHeader({ lines, index: cursor })) {
      return { format: 'context', startIndex: cursor, indexPath };
    }
    if (/^\d+(?:,\d+)?[acd]\d/u.test(text)) {
      return { format: 'normal', startIndex: cursor, indexPath };
    }
    if (/^\d+(?:,\d+)?[acd]$/u.test(text)) {
      return { format: 'ed', startIndex: cursor, indexPath };
    }
  }

  return undefined;
}

function parseIndexedSection({
  lines,
  indexed,
}: {
  lines: InputLine[],
  indexed: { format: PatchFormat, startIndex: number, indexPath: string },
}): { section: PatchSection, nextIndex: number } {
  const parsed = (() => {
    switch (indexed.format) {
    case 'unified':
      return parseUnifiedSection({ lines, startIndex: indexed.startIndex });
    case 'context':
      return parseContextSection({ lines, startIndex: indexed.startIndex });
    case 'normal':
      return parseNormalSection({ lines, startIndex: indexed.startIndex });
    case 'ed':
      return parseEdSection({ lines, startIndex: indexed.startIndex });
    default: {
      const _ex: never = indexed.format;
      throw new Error(`Unhandled indexed patch format: ${_ex}`);
    }
    }
  })();
  parsed.section.header.indexPath = indexed.indexPath;
  return parsed;
}

function parseForcedFormat({
  lines,
  format,
}: {
  lines: InputLine[],
  format: PatchFormat,
}): PatchSection[] {
  const sections: PatchSection[] = [];
  let index = 0;

  while (index < lines.length) {
    const text = decodeLine({ line: lines[index]! });
    let parsed: { section: PatchSection, nextIndex: number } | undefined;
    const indexed = findIndexedSection({ lines, index });
    if (indexed !== undefined && indexed.format === format) {
      parsed = parseIndexedSection({ lines, indexed });
    }

    switch (format) {
    case 'unified':
      if (parsed === undefined && (text.startsWith('diff --git ') || looksLikeUnifiedHeader({ lines, index }))) {
        parsed = parseUnifiedSection({ lines, startIndex: index });
      }
      break;
    case 'context':
      if (parsed === undefined && looksLikeContextHeader({ lines, index })) {
        parsed = parseContextSection({ lines, startIndex: index });
      }
      break;
    case 'normal':
      if (parsed === undefined && /^\d+(?:,\d+)?[acd]\d/u.test(text)) {
        parsed = parseNormalSection({ lines, startIndex: index });
      }
      break;
    case 'ed':
      if (parsed === undefined && /^\d+(?:,\d+)?[acd]$/u.test(text)) {
        parsed = parseEdSection({ lines, startIndex: index });
      }
      break;
    default: {
      const _ex: never = format;
      throw new Error(`Unhandled patch format: ${_ex}`);
    }
    }

    if (parsed === undefined) {
      if (format === 'unified' && text.startsWith('--- ')) {
        throw new Error(`missing +++ header after line ${lines[index]!.lineNumber}`);
      }
      if (format === 'context' && text.startsWith('*** ')) {
        throw new Error(`missing context new-file header after line ${lines[index]!.lineNumber}`);
      }
      index += 1;
      continue;
    }

    sections.push(parsed.section);
    index = parsed.nextIndex;
  }

  if (sections.length === 0 && lines.length > 0) {
    throw new Error(`patch input does not contain a ${format} diff`);
  }
  return sections;
}

export function parsePatchDocument({
  bytes,
  forcedFormat,
  binary,
}: {
  bytes: Uint8Array,
  forcedFormat: PatchFormat | undefined,
  binary: boolean,
}): ParsedPatchDocument {
  const split = splitInputLines({ bytes, stripCarriageReturns: !binary });
  const lines = split.lines;
  if (forcedFormat !== undefined) {
    return {
      sections: parseForcedFormat({ lines, format: forcedFormat }),
      strippedCarriageReturns: split.strippedCarriageReturns,
    };
  }

  const sections: PatchSection[] = [];
  let index = 0;
  while (index < lines.length) {
    const text = decodeLine({ line: lines[index]! });
    const indexed = findIndexedSection({ lines, index });
    if (indexed !== undefined) {
      const result = parseIndexedSection({ lines, indexed });
      sections.push(result.section);
      index = result.nextIndex;
      continue;
    }

    if (text.startsWith('diff --git ') || looksLikeUnifiedHeader({ lines, index })) {
      const result = parseUnifiedSection({ lines, startIndex: index });
      sections.push(result.section);
      index = result.nextIndex;
      continue;
    }

    if (looksLikeContextHeader({ lines, index })) {
      const result = parseContextSection({ lines, startIndex: index });
      sections.push(result.section);
      index = result.nextIndex;
      continue;
    }

    if (/^\d+(?:,\d+)?[acd]\d/u.test(text)) {
      const result = parseNormalSection({ lines, startIndex: index });
      sections.push(result.section);
      index = result.nextIndex;
      continue;
    }

    if (/^\d+(?:,\d+)?[acd]$/u.test(text)) {
      const result = parseEdSection({ lines, startIndex: index });
      sections.push(result.section);
      index = result.nextIndex;
      continue;
    }

    if (text.startsWith('--- ')) {
      if (sections.length > 0) break;
      throw new Error(`missing +++ header after line ${lines[index]!.lineNumber}`);
    }
    if (text.startsWith('*** ')) {
      throw new Error(`missing context new-file header after line ${lines[index]!.lineNumber}`);
    }
    if (text.startsWith('@@ ')) {
      throw new Error(`orphan unified hunk at line ${lines[index]!.lineNumber}`);
    }

    index += 1;
  }

  if (sections.length === 0 && bytes.byteLength > 0) {
    throw new Error('Only garbage was found in the patch input.');
  }

  return {
    sections,
    strippedCarriageReturns: split.strippedCarriageReturns,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  decodeGitQuotedPath,
  parseHeaderPath,
  splitInputLines,
};
