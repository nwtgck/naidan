import type {
  ApplyHunkResult,
  ApplySectionResult,
  EdPatchSection,
  FileLine,
  OutputPiece,
  PatchDirection,
  PatchLine,
  PatchLineSource,
  PatchOptions,
  PatchRange,
  PatchSection,
  TextHunk,
  TextPatchSection,
} from './types';

const encoder = new TextEncoder();

function reverseRange({ range }: { range: PatchRange }): PatchRange {
  return { start: range.start, count: range.count };
}

export function reverseHunk({ hunk }: { hunk: TextHunk }): TextHunk {
  return {
    oldRange: reverseRange({ range: hunk.newRange }),
    newRange: reverseRange({ range: hunk.oldRange }),
    heading: hunk.heading,
    lines: hunk.lines.map((line) => {
      switch (line.kind) {
      case 'context':
        return line;
      case 'remove':
        return { ...line, kind: 'add' };
      case 'add':
        return { ...line, kind: 'remove' };
      default: {
        const _ex: never = line.kind;
        throw new Error(`Unhandled patch line kind: ${_ex}`);
      }
      }
    }),
    sourceLineNumber: hunk.sourceLineNumber,
  };
}

export function reverseSection({ section }: { section: PatchSection }): PatchSection {
  const header = {
    ...section.header,
    oldPath: section.header.newPath,
    newPath: section.header.oldPath,
    oldKind: section.header.newKind,
    newKind: section.header.oldKind,
    oldMode: section.header.newMode,
    newMode: section.header.oldMode,
    renameFrom: section.header.renameTo,
    renameTo: section.header.renameFrom,
    copyFrom: section.header.copyTo,
    copyTo: section.header.copyFrom,
    operation: (() => {
      switch (section.header.operation) {
      case 'create':
        return 'delete' as const;
      case 'delete':
        return 'create' as const;
      case 'rename':
      case 'copy':
      case 'modify':
        return section.header.operation;
      default: {
        const _ex: never = section.header.operation;
        throw new Error(`Unhandled patch operation: ${_ex}`);
      }
      }
    })(),
  };

  switch (section.kind) {
  case 'text':
    return { ...section, header, hunks: section.hunks.map((hunk) => reverseHunk({ hunk })) };
  case 'ed':
    throw new Error('ed patches cannot be reversed');
  default: {
    const _ex: never = section;
    throw new Error(`Unhandled patch section: ${JSON.stringify(_ex)}`);
  }
  }
}

function getOldPatchLines({ hunk }: { hunk: TextHunk }): PatchLine[] {
  return hunk.lines.filter((line) => line.kind !== 'add');
}

function getLeadingContextCount({ oldLines }: { oldLines: PatchLine[] }): number {
  let count = 0;
  while (oldLines[count]?.kind === 'context') count += 1;
  return count;
}

function getTrailingContextCount({ oldLines }: { oldLines: PatchLine[] }): number {
  let count = 0;
  while (oldLines[oldLines.length - 1 - count]?.kind === 'context') count += 1;
  return count;
}

function* iterateCandidatePositions({
  expected,
  minimum,
  maximum,
}: {
  expected: number,
  minimum: number,
  maximum: number,
}): Generator<number> {
  if (maximum < minimum) return;
  const clampedExpected = Math.max(minimum, Math.min(maximum, expected));
  yield clampedExpected;
  const maxDistance = Math.max(clampedExpected - minimum, maximum - clampedExpected);

  for (let distance = 1; distance <= maxDistance; distance++) {
    const after = clampedExpected + distance;
    if (after <= maximum) yield after;
    const before = clampedExpected - distance;
    if (before >= minimum) yield before;
  }
}

function encodeFileLines({ lines }: { lines: FileLine[] }): Uint8Array {
  let byteLength = 0;
  for (const line of lines) {
    byteLength += line.content.byteLength;
    switch (line.terminator) {
    case 'lf':
      byteLength += 1;
      break;
    case 'none':
      break;
    default: {
      const _ex: never = line.terminator;
      throw new Error(`Unhandled line terminator: ${_ex}`);
    }
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const line of lines) {
    bytes.set(line.content, offset);
    offset += line.content.byteLength;
    switch (line.terminator) {
    case 'lf':
      bytes[offset] = 0x0a;
      offset += 1;
      break;
    case 'none':
      break;
    default: {
      const _ex: never = line.terminator;
      throw new Error(`Unhandled line terminator: ${_ex}`);
    }
    }
  }
  return bytes;
}

function patchLineAsFileLine({ line }: { line: PatchLine }): FileLine {
  return { content: line.content, terminator: line.terminator };
}

function pushPiece({ output, piece }: { output: OutputPiece[], piece: OutputPiece }): void {
  switch (piece.kind) {
  case 'source': {
    if (piece.startLine === piece.endLine) return;
    const previous = output[output.length - 1];
    if (previous?.kind === 'source' && previous.endLine === piece.startLine) {
      previous.endLine = piece.endLine;
      return;
    }
    output.push(piece);
    return;
  }
  case 'bytes':
    if (piece.bytes.byteLength === 0 && piece.lineCount === 0) return;
    output.push(piece);
    return;
  default: {
    const _ex: never = piece;
    throw new Error(`Unhandled output piece: ${JSON.stringify(_ex)}`);
  }
  }
}

function pushSourcePiece({
  output,
  startLine,
  endLine,
}: {
  output: OutputPiece[],
  startLine: number,
  endLine: number,
}): void {
  pushPiece({ output, piece: { kind: 'source', startLine, endLine } });
}

function pushLinesPiece({
  output,
  lines,
}: {
  output: OutputPiece[],
  lines: FileLine[],
}): void {
  if (lines.length === 0) return;
  pushPiece({
    output,
    piece: {
      kind: 'bytes',
      bytes: encodeFileLines({ lines }),
      lineCount: lines.length,
    },
  });
}

async function candidateMatches({
  source,
  oldLines,
  candidate,
  ignoredLeading,
  ignoredTrailing,
  whitespaceMode,
}: {
  source: PatchLineSource,
  oldLines: PatchLine[],
  candidate: number,
  ignoredLeading: number,
  ignoredTrailing: number,
  whitespaceMode: PatchOptions['whitespaceMode'],
}): Promise<boolean> {
  for (let index = 0; index < oldLines.length; index++) {
    const patchLine = oldLines[index];
    if (patchLine === undefined) return false;
    const ignored = index < ignoredLeading || index >= oldLines.length - ignoredTrailing;
    if (ignored && patchLine.kind === 'context') continue;
    if (!await source.lineMatches({
      lineIndex: candidate + index,
      patchLine,
      whitespaceMode,
    })) {
      return false;
    }
  }
  return true;
}

function directiveLine({ value }: { value: string }): FileLine {
  return { content: encoder.encode(value), terminator: 'lf' };
}

function appendConditionalChange({
  output,
  removedStart,
  removedCount,
  added,
  name,
}: {
  output: OutputPiece[],
  removedStart: number,
  removedCount: number,
  added: FileLine[],
  name: string,
}): void {
  if (removedCount > 0 && added.length > 0) {
    pushLinesPiece({ output, lines: [directiveLine({ value: `#ifndef ${name}` })] });
    pushSourcePiece({ output, startLine: removedStart, endLine: removedStart + removedCount });
    pushLinesPiece({ output, lines: [directiveLine({ value: '#else' })] });
    pushLinesPiece({ output, lines: added });
    pushLinesPiece({ output, lines: [directiveLine({ value: `#endif /* ${name} */` })] });
    return;
  }

  if (removedCount > 0) {
    pushLinesPiece({ output, lines: [directiveLine({ value: `#ifndef ${name}` })] });
    pushSourcePiece({ output, startLine: removedStart, endLine: removedStart + removedCount });
    pushLinesPiece({ output, lines: [directiveLine({ value: `#endif /* ${name} */` })] });
    return;
  }

  if (added.length > 0) {
    pushLinesPiece({ output, lines: [directiveLine({ value: `#ifdef ${name}` })] });
    pushLinesPiece({ output, lines: added });
    pushLinesPiece({ output, lines: [directiveLine({ value: `#endif /* ${name} */` })] });
  }
}

function buildReplacementPieces({
  hunk,
  candidate,
  ifdefName,
}: {
  hunk: TextHunk,
  candidate: number,
  ifdefName: string | undefined,
}): OutputPiece[] {
  const pieces: OutputPiece[] = [];
  let sourceIndex = candidate;
  let patchIndex = 0;

  while (patchIndex < hunk.lines.length) {
    const patchLine = hunk.lines[patchIndex]!;
    switch (patchLine.kind) {
    case 'context':
      pushSourcePiece({ output: pieces, startLine: sourceIndex, endLine: sourceIndex + 1 });
      sourceIndex += 1;
      patchIndex += 1;
      continue;
    case 'remove':
    case 'add':
      break;
    default: {
      const _ex: never = patchLine.kind;
      throw new Error(`Unhandled patch line kind: ${_ex}`);
    }
    }

    const removedStart = sourceIndex;
    let removedCount = 0;
    const added: FileLine[] = [];
    while (patchIndex < hunk.lines.length && hunk.lines[patchIndex]?.kind !== 'context') {
      const changedLine = hunk.lines[patchIndex]!;
      switch (changedLine.kind) {
      case 'remove':
        sourceIndex += 1;
        removedCount += 1;
        break;
      case 'add':
        added.push(patchLineAsFileLine({ line: changedLine }));
        break;
      case 'context':
        throw new Error('internal context grouping error');
      default: {
        const _ex: never = changedLine.kind;
        throw new Error(`Unhandled changed line kind: ${_ex}`);
      }
      }
      patchIndex += 1;
    }

    if (ifdefName === undefined) {
      pushLinesPiece({ output: pieces, lines: added });
    } else {
      appendConditionalChange({
        output: pieces,
        removedStart,
        removedCount,
        added,
        name: ifdefName,
      });
    }
  }

  return pieces;
}

export async function applyHunk({
  source,
  hunk,
  expected,
  minimumCandidate,
  maxFuzz,
  whitespaceMode,
  ifdefName,
}: {
  source: PatchLineSource,
  hunk: TextHunk,
  expected: number,
  minimumCandidate: number,
  maxFuzz: number,
  whitespaceMode: PatchOptions['whitespaceMode'],
  ifdefName: string | undefined,
}): Promise<ApplyHunkResult> {
  const oldLines = getOldPatchLines({ hunk });
  if (oldLines.length !== hunk.oldRange.count) {
    throw new Error(`internal hunk old-line count mismatch at patch line ${hunk.sourceLineNumber}`);
  }

  const leadingContext = getLeadingContextCount({ oldLines });
  const trailingContext = getTrailingContextCount({ oldLines });
  const maximumFuzz = Math.min(maxFuzz, Math.max(leadingContext, trailingContext));
  const maximumCandidate = source.lineCount - oldLines.length;

  for (let fuzz = 0; fuzz <= maximumFuzz; fuzz++) {
    const ignoredLeading = Math.min(fuzz, leadingContext);
    const ignoredTrailing = Math.min(fuzz, trailingContext);
    const candidates = oldLines.length === 0
      ? [Math.max(minimumCandidate, Math.min(source.lineCount, expected))]
      : iterateCandidatePositions({ expected, minimum: minimumCandidate, maximum: maximumCandidate });

    for (const candidate of candidates) {
      if (!await candidateMatches({
        source,
        oldLines,
        candidate,
        ignoredLeading,
        ignoredTrailing,
        whitespaceMode,
      })) {
        continue;
      }

      return {
        kind: 'success',
        pieces: buildReplacementPieces({ hunk, candidate, ifdefName }),
        matchedAt: candidate,
        offset: candidate - expected,
        fuzz,
      };
    }
  }

  return { kind: 'failure' };
}

function pluralizeLines({ count }: { count: number }): string {
  return count === 1 ? 'line' : 'lines';
}

function getExpectedSourceIndex({ range }: { range: PatchRange }): number {
  if (range.count === 0) return range.start;
  return range.start === 0 ? 0 : range.start - 1;
}

async function applyTextHunks({
  source,
  section,
  options,
  direction,
}: {
  source: PatchLineSource,
  section: TextPatchSection,
  options: PatchOptions,
  direction: PatchDirection,
}): Promise<ApplySectionResult> {
  const activeSection = (() => {
    switch (direction) {
    case 'forward':
      return section;
    case 'reverse':
      return reverseSection({ section }) as TextPatchSection;
    default: {
      const _ex: never = direction;
      throw new Error(`Unhandled patch direction: ${_ex}`);
    }
    }
  })();
  const output: OutputPiece[] = [];
  let sourceCursor = 0;
  let previousOffset = 0;
  let minimumCandidate = 0;
  let usedOffset = false;
  let usedFuzz = false;
  const rejectedHunks: TextHunk[] = [];
  const diagnostics: string[] = [];

  for (let index = 0; index < activeSection.hunks.length; index++) {
    const hunk = activeSection.hunks[index]!;
    const baseExpected = getExpectedSourceIndex({ range: hunk.oldRange });
    const expected = baseExpected + previousOffset;
    const result = await applyHunk({
      source,
      hunk,
      expected,
      minimumCandidate,
      maxFuzz: options.fuzz,
      whitespaceMode: options.whitespaceMode,
      ifdefName: options.ifdefName,
    });

    switch (result.kind) {
    case 'failure':
      rejectedHunks.push(hunk);
      diagnostics.push(`Hunk #${index + 1} FAILED at ${hunk.oldRange.start}.`);
      continue;
    case 'success':
      break;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled hunk result: ${JSON.stringify(_ex)}`);
    }
    }

    pushSourcePiece({ output, startLine: sourceCursor, endLine: result.matchedAt });
    for (const piece of result.pieces) pushPiece({ output, piece });
    sourceCursor = result.matchedAt + hunk.oldRange.count;
    minimumCandidate = sourceCursor;
    previousOffset = result.offset;
    usedOffset ||= result.offset !== 0;
    usedFuzz ||= result.fuzz !== 0;

    if (result.offset !== 0 || result.fuzz !== 0 || options.quietMode === 'verbose') {
      const parts = [`Hunk #${index + 1} succeeded at ${result.matchedAt + 1}`];
      if (result.fuzz !== 0) parts.push(`with fuzz ${result.fuzz}`);
      if (result.offset !== 0) {
        const sign = result.offset > 0 ? '' : '-';
        const absolute = Math.abs(result.offset);
        parts.push(`(offset ${sign}${absolute} ${pluralizeLines({ count: absolute })})`);
      }
      diagnostics.push(`${parts.join(' ')}.`);
    }
  }

  pushSourcePiece({ output, startLine: sourceCursor, endLine: source.lineCount });
  return {
    pieces: output,
    rejectedHunks,
    usedOffset,
    usedFuzz,
    diagnostics,
    direction,
  };
}

async function firstHunkApplies({
  source,
  section,
  options,
}: {
  source: PatchLineSource,
  section: TextPatchSection,
  options: PatchOptions,
}): Promise<boolean> {
  const first = section.hunks[0];
  if (first === undefined) return true;
  const expected = getExpectedSourceIndex({ range: first.oldRange });
  return (await applyHunk({
    source,
    hunk: first,
    expected,
    minimumCandidate: 0,
    maxFuzz: options.fuzz,
    whitespaceMode: options.whitespaceMode,
    ifdefName: options.ifdefName,
  })).kind === 'success';
}

export async function applyTextSection({
  source,
  section,
  options,
}: {
  source: PatchLineSource,
  section: TextPatchSection,
  options: PatchOptions,
}): Promise<ApplySectionResult> {
  switch (options.directionMode) {
  case 'reverse':
    return applyTextHunks({ source, section, options, direction: 'reverse' });
  case 'auto':
  case 'forward-only':
    break;
  default: {
    const _ex: never = options.directionMode;
    throw new Error(`Unhandled direction mode: ${_ex}`);
  }
  }

  const forwardApplies = await firstHunkApplies({ source, section, options });
  if (forwardApplies || options.reverseDecisionMode === 'force-forward') {
    return applyTextHunks({ source, section, options, direction: 'forward' });
  }

  const reversedSection = reverseSection({ section });
  const reversed = (() => {
    switch (reversedSection.kind) {
    case 'text':
      return reversedSection;
    case 'ed':
      throw new Error('internal reversed section type mismatch');
    default: {
      const _ex: never = reversedSection;
      throw new Error(`Unhandled reversed section: ${JSON.stringify(_ex)}`);
    }
    }
  })();
  const reverseApplies = await firstHunkApplies({ source, section: reversed, options });
  if (!reverseApplies) {
    return applyTextHunks({ source, section, options, direction: 'forward' });
  }

  if (options.directionMode === 'forward-only' || options.reverseDecisionMode === 'safe-skip') {
    return {
      pieces: [{ kind: 'source', startLine: 0, endLine: source.lineCount }],
      rejectedHunks: section.hunks,
      usedOffset: false,
      usedFuzz: false,
      diagnostics: ['Reversed (or previously applied) patch detected!  Skipping patch.'],
      direction: 'forward',
    };
  }

  return applyTextHunks({ source, section, options, direction: 'reverse' });
}

type EdPiece =
  | { kind: 'source', startLine: number, endLine: number }
  | { kind: 'inserted', lines: FileLine[] };

function edPieceLineCount({ piece }: { piece: EdPiece }): number {
  switch (piece.kind) {
  case 'source':
    return piece.endLine - piece.startLine;
  case 'inserted':
    return piece.lines.length;
  default: {
    const _ex: never = piece;
    throw new Error(`Unhandled ed piece: ${JSON.stringify(_ex)}`);
  }
  }
}

function edSequenceLineCount({ pieces }: { pieces: EdPiece[] }): number {
  let count = 0;
  for (const piece of pieces) count += edPieceLineCount({ piece });
  return count;
}

function splitEdPiecesAt({
  pieces,
  lineIndex,
}: {
  pieces: EdPiece[],
  lineIndex: number,
}): number {
  const total = edSequenceLineCount({ pieces });
  if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || lineIndex > total) {
    throw new Error(`ed line index is outside the file: ${lineIndex}`);
  }
  if (lineIndex === total) return pieces.length;

  let cursor = 0;
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    const count = edPieceLineCount({ piece });
    if (lineIndex === cursor) return index;
    if (lineIndex > cursor && lineIndex < cursor + count) {
      const offset = lineIndex - cursor;
      switch (piece.kind) {
      case 'source':
        pieces.splice(index, 1,
          { kind: 'source', startLine: piece.startLine, endLine: piece.startLine + offset },
          { kind: 'source', startLine: piece.startLine + offset, endLine: piece.endLine },
        );
        return index + 1;
      case 'inserted':
        pieces.splice(index, 1,
          { kind: 'inserted', lines: piece.lines.slice(0, offset) },
          { kind: 'inserted', lines: piece.lines.slice(offset) },
        );
        return index + 1;
      default: {
        const _ex: never = piece;
        throw new Error(`Unhandled ed piece: ${JSON.stringify(_ex)}`);
      }
      }
    }
    cursor += count;
  }

  throw new Error(`failed to locate ed line index ${lineIndex}`);
}

function spliceEdPieces({
  pieces,
  start,
  deleteCount,
  insertedLines,
}: {
  pieces: EdPiece[],
  start: number,
  deleteCount: number,
  insertedLines: FileLine[],
}): void {
  const startPieceIndex = splitEdPiecesAt({ pieces, lineIndex: start });
  const endPieceIndex = splitEdPiecesAt({ pieces, lineIndex: start + deleteCount });
  const replacement = insertedLines.length === 0
    ? []
    : [{ kind: 'inserted' as const, lines: insertedLines }];
  pieces.splice(startPieceIndex, endPieceIndex - startPieceIndex, ...replacement);
}

export function applyEdSection({
  source,
  section,
}: {
  source: PatchLineSource,
  section: EdPatchSection,
}): OutputPiece[] {
  const pieces: EdPiece[] = source.lineCount === 0
    ? []
    : [{ kind: 'source', startLine: 0, endLine: source.lineCount }];

  for (const command of section.commands) {
    const lineCount = edSequenceLineCount({ pieces });
    switch (command.operation) {
    case 'append':
      if (command.start < 0 || command.start > lineCount) {
        throw new Error(`ed append address is outside the file at patch line ${command.sourceLineNumber}`);
      }
      spliceEdPieces({
        pieces,
        start: command.start,
        deleteCount: 0,
        insertedLines: command.lines.map((line) => ({ ...line })),
      });
      break;
    case 'change':
      if (command.start < 1 || command.end > lineCount) {
        throw new Error(`ed change address is outside the file at patch line ${command.sourceLineNumber}`);
      }
      spliceEdPieces({
        pieces,
        start: command.start - 1,
        deleteCount: command.end - command.start + 1,
        insertedLines: command.lines.map((line) => ({ ...line })),
      });
      break;
    case 'delete':
      if (command.start < 1 || command.end > lineCount) {
        throw new Error(`ed delete address is outside the file at patch line ${command.sourceLineNumber}`);
      }
      spliceEdPieces({
        pieces,
        start: command.start - 1,
        deleteCount: command.end - command.start + 1,
        insertedLines: [],
      });
      break;
    default: {
      const _ex: never = command.operation;
      throw new Error(`Unhandled ed operation: ${_ex}`);
    }
    }
  }

  const output: OutputPiece[] = [];
  for (const piece of pieces) {
    switch (piece.kind) {
    case 'source':
      pushSourcePiece({ output, startLine: piece.startLine, endLine: piece.endLine });
      break;
    case 'inserted':
      pushLinesPiece({ output, lines: piece.lines });
      break;
    default: {
      const _ex: never = piece;
      throw new Error(`Unhandled ed piece: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return output;
}

class ByteChunkBuilder {
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;

  push({ bytes }: { bytes: Uint8Array }): void {
    if (bytes.byteLength === 0) return;
    this.chunks.push(bytes);
    this.byteLength += bytes.byteLength;
  }

  finish(): Uint8Array {
    const result = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

function pushAscii({ output, value }: { output: ByteChunkBuilder, value: string }): void {
  output.push({ bytes: encoder.encode(value) });
}

function pushPatchLine({ output, prefix, line }: { output: ByteChunkBuilder, prefix: string, line: PatchLine }): void {
  pushAscii({ output, value: prefix });
  output.push({ bytes: line.content });
  switch (line.terminator) {
  case 'lf':
    output.push({ bytes: new Uint8Array([0x0a]) });
    break;
  case 'none':
    pushAscii({ output, value: '\n\\ No newline at end of file\n' });
    break;
  default: {
    const _ex: never = line.terminator;
    throw new Error(`Unhandled patch line terminator: ${_ex}`);
  }
  }
}

export function serializeUnifiedReject({
  hunk,
  oldPath,
  newPath,
}: {
  hunk: TextHunk,
  oldPath: string,
  newPath: string,
}): Uint8Array {
  const output = new ByteChunkBuilder();
  pushAscii({ output, value: `--- ${oldPath}\n+++ ${newPath}\n` });
  const oldCount = hunk.oldRange.count === 1 ? '' : `,${hunk.oldRange.count}`;
  const newCount = hunk.newRange.count === 1 ? '' : `,${hunk.newRange.count}`;
  pushAscii({ output, value: `@@ -${hunk.oldRange.start}${oldCount} +${hunk.newRange.start}${newCount} @@${hunk.heading === undefined ? '' : ` ${hunk.heading}`}\n` });
  for (const line of hunk.lines) {
    const prefix = (() => {
      switch (line.kind) {
      case 'context': return ' ';
      case 'remove': return '-';
      case 'add': return '+';
      default: {
        const _ex: never = line.kind;
        throw new Error(`Unhandled reject line kind: ${_ex}`);
      }
      }
    })();
    pushPatchLine({ output, prefix, line });
  }
  return output.finish();
}

export function serializeContextReject({
  hunk,
  oldPath,
  newPath,
}: {
  hunk: TextHunk,
  oldPath: string,
  newPath: string,
}): Uint8Array {
  const output = new ByteChunkBuilder();
  pushAscii({ output, value: `*** ${oldPath}\n--- ${newPath}\n***************\n` });
  const oldEnd = hunk.oldRange.count === 0 ? hunk.oldRange.start : hunk.oldRange.start + hunk.oldRange.count - 1;
  const newEnd = hunk.newRange.count === 0 ? hunk.newRange.start : hunk.newRange.start + hunk.newRange.count - 1;
  pushAscii({ output, value: `*** ${hunk.oldRange.start},${oldEnd} ****\n` });
  for (const line of hunk.lines) {
    switch (line.kind) {
    case 'context':
      pushPatchLine({ output, prefix: '  ', line });
      break;
    case 'remove':
      pushPatchLine({ output, prefix: '- ', line });
      break;
    case 'add':
      break;
    default: {
      const _ex: never = line.kind;
      throw new Error(`Unhandled context reject line kind: ${_ex}`);
    }
    }
  }
  pushAscii({ output, value: `--- ${hunk.newRange.start},${newEnd} ----\n` });
  for (const line of hunk.lines) {
    switch (line.kind) {
    case 'context':
      pushPatchLine({ output, prefix: '  ', line });
      break;
    case 'add':
      pushPatchLine({ output, prefix: '+ ', line });
      break;
    case 'remove':
      break;
    default: {
      const _ex: never = line.kind;
      throw new Error(`Unhandled context reject line kind: ${_ex}`);
    }
    }
  }
  return output.finish();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  applyHunk,
};
