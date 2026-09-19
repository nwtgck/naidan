import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { jqArgvSpec, parseJqArgv, type JqInjectedArgument } from '@/features/wesh/commands/jq/argv';
import type { JsonValue, JqFilter, JqPathExpression, JqUserDefinition } from '@/features/wesh/commands/jq/ast';
import { validateJqProgram } from '@/features/wesh/commands/jq/compile';
import { formatJsonOutput, parseJsonSequence, scanJsonSequenceIncrementally } from '@/features/wesh/commands/jq/json';
import { getJsonChildNumberOrigin, setJsonChildNumberOrigin, type JqNumberOrigin } from '@/features/wesh/commands/jq/number-origin';
import { parseJqProgram } from '@/features/wesh/commands/jq/parser';
import {
  evaluateJqFilter,
  failureOutputs,
  type JqRuntimeError,
  type JqRuntimeInputEntry,
  type JqRuntimeInputMetadata,
  type JqRuntimeInputState,
} from '@/features/wesh/commands/jq/runtime';
import { createJsonObject, defineJsonProperty, jsonObjectKeys } from '@/features/wesh/commands/jq/value';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { openHandleReadStream, readAllFileText } from '@/features/wesh/utils/fs';

const OUTPUT_BUFFER_LIMIT = 16 * 1024;
const JQ_WESH_VERSION = 'jq-wesh-1.7-compatible';

interface JqOutputOptions {
  compact: boolean,
  raw: boolean,
  join: boolean,
  asciiOnly: boolean,
  sortKeys: boolean,
  indentation: number | '\t',
  nullSeparator: boolean,
  unbuffered: boolean,
}

interface JqInputOptions {
  nullInput: boolean,
  rawInput: boolean,
  slurp: boolean,
}

class BufferedStdout {
  private readonly context: WeshCommandContext;
  private pending = '';

  public constructor({
    context,
  }: {
    context: WeshCommandContext,
  }) {
    this.context = context;
  }

  public async write({
    text,
    flush,
  }: {
    text: string,
    flush: boolean,
  }): Promise<void> {
    if (text.length >= OUTPUT_BUFFER_LIMIT && this.pending.length === 0) {
      await this.context.text().print({ text });
      return;
    }

    this.pending += text;
    if (flush || this.pending.length >= OUTPUT_BUFFER_LIMIT) {
      await this.flush();
    }
  }

  public async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const text = this.pending;
    this.pending = '';
    await this.context.text().print({ text });
  }
}

function optionBoolean({
  optionValues,
  key,
}: {
  optionValues: Record<string, boolean | string | number>,
  key: string,
}): boolean {
  return optionValues[key] === true;
}

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  if (path.startsWith('/')) return path;
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

async function readTextStream({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
}): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const fragments: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return fragments.join('');
  } finally {
    reader.releaseLock();
  }
}

function jqInputReadErrorMessage({
  error,
}: {
  error: unknown,
}): string {
  const errorName = typeof error === 'object'
    && error !== null
    && 'name' in error
    && typeof error.name === 'string'
    ? error.name
    : undefined;
  const rendered = error instanceof Error ? error.message : String(error);
  if (errorName === 'NotFoundError' || rendered.startsWith('NotFoundError:')) {
    return 'No such file or directory';
  }
  return rendered;
}

async function readPathText({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<{ ok: true, text: string } | { ok: false, message: string }> {
  try {
    return {
      ok: true,
      text: await readAllFileText({
        files: context.files,
        path: resolvePath({ cwd: context.cwd, path }),
      }),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: `jq: error: Could not open file ${path}: ${jqInputReadErrorMessage({ error })}`,
    };
  }
}

async function readInputText({
  context,
  path,
  stdinState,
}: {
  context: WeshCommandContext,
  path: string,
  stdinState: { consumed: boolean },
}): Promise<{ ok: true, text: string } | { ok: false, message: string }> {
  if (path !== '-') return readPathText({ context, path });
  if (stdinState.consumed) return { ok: true, text: '' };

  stdinState.consumed = true;
  try {
    return {
      ok: true,
      text: await readTextStream({
        stream: openHandleReadStream({ handle: context.stdin }),
      }),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `jq: error: Could not read standard input: ${message}` };
  }
}

type JqCursorResult =
  | { kind: 'value', value: JsonValue, filename: string | null, lineNumber: number, numberOrigin?: JqNumberOrigin }
  | { kind: 'diagnostic', message: string }
  | { kind: 'terminal_error', error: JqRuntimeError }
  | { kind: 'exhausted' };

type JqCursorEntry =
  | { ok: true, value: JsonValue, filename: string, lineNumber: number, numberOrigin?: JqNumberOrigin }
  | { ok: false, message: string, filename: string, lineNumber: number };

type JqCursorValueResult = Extract<JqCursorResult, { kind: 'value' }>;
type JqBufferedCursorResult = JqCursorValueResult | Extract<JqCursorResult, { kind: 'terminal_error' }>;

// Demand replay may parse ahead only inside an already loaded input path. The
// geometric window amortizes whole-filter replay without opening later paths.
// This threshold only compacts already-consumed buffered entries; it does not
// cap the replay window and therefore cannot restore quadratic replay scaling.
const JQ_DEMAND_REPLAY_BUFFER_COMPACT_THRESHOLD = 4_096;

function cursorEntryResult({
  entry,
}: {
  entry: JqCursorEntry,
}): JqBufferedCursorResult {
  return entry.ok
    ? {
      kind: 'value',
      value: entry.value,
      filename: entry.filename,
      lineNumber: entry.lineNumber,
      ...(entry.numberOrigin === undefined ? {} : { numberOrigin: entry.numberOrigin }),
    }
    : {
      kind: 'terminal_error',
      error: {
        message: `parse error: ${entry.message}`,
        value: `parse error: ${entry.message}`,
        metadata: { filename: entry.filename, lineNumber: entry.lineNumber },
      },
    };
}

function runtimeInputEntryForCursorValue({
  result,
}: {
  result: JqCursorValueResult,
}): JqRuntimeInputEntry {
  // JqCursorValueResult structurally contains the runtime input entry. Reuse
  // the buffered object so geometric lookahead does not duplicate metadata and
  // JSON-value wrapper objects while the same prefix is replayed.
  return result;
}

interface JqInputBufferSegmentLineState {
  lastCompletionOffset: number,
  completedNewlines: number,
  nextNewlineOffset: number,
}

interface JqParserBufferBoundary {
  /**
   * Text offset after the bytes wholly contained in this parser buffer. When
   * the 4095-byte fgets payload boundary bisects a UTF-8 sequence, this points
   * to the start of that code point because the code point is only available
   * to the decoded text after the following buffer supplies its continuation
   * bytes.
   */
  readonly textEnd: number,
  /** Text offset covered by the raw bytes in this buffer, including a split code point. */
  readonly coveredTextEnd: number,
  /** Whether the next parser buffer starts with UTF-8 continuation bytes. */
  readonly splitsUtf8Sequence: boolean,
  /** Raw continuation bytes that remain at the start of the following parser buffer. */
  readonly continuationByteCount: number,
}

interface JqInputBufferSegment {
  readonly path: string,
  readonly text: string,
  readonly start: number,
  readonly end: number,
  readonly textOffset: number,
  readonly parserBufferBoundaries: readonly JqParserBufferBoundary[],
  readonly lineState: JqInputBufferSegmentLineState,
}

type JqAvailableInputResult =
  | { readonly kind: 'result', readonly result: JqBufferedCursorResult }
  | { readonly kind: 'need_more_input', readonly pendingToken: boolean }
  | { readonly kind: 'exhausted' };

const JQ_PARSER_INPUT_BUFFER_PAYLOAD_LENGTH = 4095;

function utf8CodePointByteLength({
  text,
  index,
}: {
  text: string,
  index: number,
}): { readonly byteLength: number, readonly textEnd: number } {
  const first = text.charCodeAt(index);
  if (first <= 0x7f) return { byteLength: 1, textEnd: index + 1 };
  if (first <= 0x7ff) return { byteLength: 2, textEnd: index + 1 };
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return { byteLength: 4, textEnd: index + 2 };
    }
  }
  // TextDecoder replacement characters and lone surrogate code units encode
  // to three bytes under the same UTF-8 semantics used by TextEncoder.
  return { byteLength: 3, textEnd: index + 1 };
}

function jqParserBufferBoundaries({
  text,
}: {
  text: string,
}): readonly JqParserBufferBoundary[] {
  const boundaries: JqParserBufferBoundary[] = [];
  let bufferByteLength = 0;
  let index = 0;

  while (index < text.length) {
    const codePointStart = index;
    const codePoint = utf8CodePointByteLength({ text, index });
    let remainingBytes = codePoint.byteLength;

    while (remainingBytes > 0) {
      const availableBytes = JQ_PARSER_INPUT_BUFFER_PAYLOAD_LENGTH - bufferByteLength;
      if (remainingBytes > availableBytes) {
        // fgets may end in the middle of a multi-byte UTF-8 code point. The
        // jq parser normally carries the token across that boundary. If a
        // parse error resets the parser first, however, the next buffer starts
        // with the raw continuation byte(s), which creates another parse
        // error. Preserve that distinction without splitting JavaScript text.
        remainingBytes -= availableBytes;
        boundaries.push({
          textEnd: codePointStart,
          coveredTextEnd: codePoint.textEnd,
          splitsUtf8Sequence: true,
          continuationByteCount: remainingBytes,
        });
        bufferByteLength = 0;
        continue;
      }

      bufferByteLength += remainingBytes;
      remainingBytes = 0;
      index = codePoint.textEnd;

      const completedNewline = text[codePointStart] === '\n';
      if (completedNewline || bufferByteLength === JQ_PARSER_INPUT_BUFFER_PAYLOAD_LENGTH) {
        boundaries.push({
          textEnd: index,
          coveredTextEnd: index,
          splitsUtf8Sequence: false,
          continuationByteCount: 0,
        });
        bufferByteLength = 0;
      }
    }
  }

  if (bufferByteLength > 0) {
    boundaries.push({
      textEnd: text.length,
      coveredTextEnd: text.length,
      splitsUtf8Sequence: false,
      continuationByteCount: 0,
    });
  }
  return boundaries;
}

function countNewlines({
  text,
  end,
}: {
  text: string,
  end: number,
}): number {
  let count = 0;
  let index = 0;
  while (true) {
    const newlineIndex = text.indexOf('\n', index);
    if (newlineIndex < 0 || newlineIndex >= end) return count;
    count += 1;
    index = newlineIndex + 1;
  }
}

class JqInputCursor {
  private readonly context: WeshCommandContext;
  private readonly paths: readonly string[];
  private readonly options: JqInputOptions;
  private readonly stdinState = { consumed: false };
  private pathIndex = 0;
  private sourceText = '';
  private sourceIndex = 0;
  private sourceSegments: JqInputBufferSegment[] = [];
  private pendingUtf8RecoveryToken: {
    readonly initialTextEnd: number | undefined,
    readonly originColumn: number,
    readonly tokenByteLength: number,
  } | undefined;
  private lastLoadedPath: string | undefined;
  private lastLoadedLineNumberAtEnd = 0;
  private sourceExhausted = false;
  private queuedResults: JqCursorResult[] = [];
  private bufferedResults: JqBufferedCursorResult[] = [];
  private bufferedResultIndex = 0;
  private slurpedValues: JsonValue[] = [];
  private slurpedRawFragments: string[] = [];
  private slurpedMetadata: JqRuntimeInputMetadata = { filename: null, lineNumber: 0 };
  private slurpComplete = false;
  private slurpEmitted = false;

  public constructor({
    context,
    paths,
    options,
  }: {
    context: WeshCommandContext,
    paths: readonly string[],
    options: JqInputOptions,
  }) {
    this.context = context;
    this.paths = paths;
    this.options = options;
  }

  public async next(): Promise<JqCursorResult> {
    return this.options.slurp
      ? this.nextSlurped()
      : this.nextUnslurped();
  }

  public peekAvailableValues({
    maximumValues,
  }: {
    maximumValues: number,
  }): readonly JqCursorValueResult[] {
    if (this.options.slurp || maximumValues <= 0) return [];

    const values: JqCursorValueResult[] = [];
    let bufferedIndex = this.bufferedResultIndex;
    while (values.length < maximumValues) {
      const buffered = this.bufferedResults[bufferedIndex];
      if (buffered !== undefined) {
        switch (buffered.kind) {
        case 'value':
          values.push(buffered);
          bufferedIndex += 1;
          continue;
        case 'terminal_error':
          break;
        default: {
          const _ex: never = buffered;
          throw new Error(`Unhandled jq buffered cursor result: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }

      const available = this.parseAvailableInput({
        endOfInput: this.sourceExhausted,
        boundaryMetadata: this.sourceExhausted ? this.lastSourceBoundaryMetadata() : undefined,
      });
      switch (available.kind) {
      case 'result':
        this.bufferedResults.push(available.result);
        switch (available.result.kind) {
        case 'value':
          values.push(available.result);
          bufferedIndex += 1;
          continue;
        case 'terminal_error':
          return values;
        default: {
          const _ex: never = available.result;
          throw new Error(`Unhandled jq parser cursor result: ${JSON.stringify(_ex)}`);
        }
        }
      case 'need_more_input':
      case 'exhausted':
        return values;
      default: {
        const _ex: never = available;
        throw new Error(`Unhandled jq available input result: ${JSON.stringify(_ex)}`);
      }
      }
    }
    return values;
  }

  public commitPeekedValues({
    count,
  }: {
    count: number,
  }): void {
    const bufferedValueCount = this.bufferedResults.length - this.bufferedResultIndex;
    if (!Number.isSafeInteger(count) || count < 0 || count > bufferedValueCount) {
      throw new Error(`Invalid jq cursor lookahead commit count: ${count}`);
    }
    for (let offset = 0; offset < count; offset += 1) {
      const result = this.bufferedResults[this.bufferedResultIndex + offset];
      if (result === undefined) {
        throw new Error(`Missing jq cursor lookahead result at offset ${offset}`);
      }
      switch (result.kind) {
      case 'value':
        break;
      case 'terminal_error':
        throw new Error(`Cannot commit jq cursor lookahead result: ${result.kind}`);
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled jq cursor lookahead result: ${JSON.stringify(_ex)}`);
      }
      }
    }
    this.bufferedResultIndex += count;
    this.compactBufferedResults();
  }

  private compactBufferedResults(): void {
    if (this.bufferedResultIndex === 0) return;
    if (this.bufferedResultIndex === this.bufferedResults.length) {
      this.bufferedResults = [];
      this.bufferedResultIndex = 0;
      return;
    }
    if (
      this.bufferedResultIndex >= JQ_DEMAND_REPLAY_BUFFER_COMPACT_THRESHOLD
      && this.bufferedResultIndex * 2 >= this.bufferedResults.length
    ) {
      this.bufferedResults = this.bufferedResults.slice(this.bufferedResultIndex);
      this.bufferedResultIndex = 0;
    }
  }

  private async loadNextPath(): Promise<
    | { kind: 'loaded', text: string, path: string }
    | { kind: 'diagnostic', message: string, path: string }
    | { kind: 'exhausted' }
    > {
    const path = this.paths[this.pathIndex];
    if (path === undefined) return { kind: 'exhausted' };
    this.pathIndex += 1;
    const loaded = await readInputText({
      context: this.context,
      path,
      stdinState: this.stdinState,
    });
    const displayPath = path === '-' ? '<stdin>' : path;
    return loaded.ok
      ? { kind: 'loaded', text: loaded.text, path: displayPath }
      : { kind: 'diagnostic', message: loaded.message, path: displayPath };
  }

  private appendInputSegment({
    text,
    path,
  }: {
    text: string,
    path: string,
  }): void {
    const start = this.sourceText.length;
    this.sourceText += text;
    if (text.length > 0) {
      this.sourceSegments.push({
        path,
        text,
        start,
        end: start + text.length,
        textOffset: 0,
        parserBufferBoundaries: jqParserBufferBoundaries({ text }),
        lineState: {
          lastCompletionOffset: 0,
          completedNewlines: 0,
          nextNewlineOffset: text.indexOf('\n'),
        },
      });
    }
    this.lastLoadedPath = path;
    this.lastLoadedLineNumberAtEnd = countNewlines({ text, end: text.length });
  }

  private compactSourceBefore({
    index,
  }: {
    index: number,
  }): void {
    if (index <= 0) return;
    if (index > this.sourceText.length) {
      throw new Error(`Invalid jq input buffer compaction index: ${index}`);
    }

    this.sourceText = this.sourceText.slice(index);
    this.sourceIndex = Math.max(0, this.sourceIndex - index);
    const compacted: JqInputBufferSegment[] = [];
    for (const segment of this.sourceSegments) {
      if (segment.end <= index) continue;
      const removedFromSegment = Math.max(0, index - segment.start);
      compacted.push({
        path: segment.path,
        text: segment.text,
        start: Math.max(0, segment.start - index),
        end: segment.end - index,
        textOffset: segment.textOffset + removedFromSegment,
        parserBufferBoundaries: segment.parserBufferBoundaries,
        lineState: segment.lineState,
      });
    }
    this.sourceSegments = compacted;
  }

  private lineNumberForCompletion({
    segment,
    completionOffset,
  }: {
    segment: JqInputBufferSegment,
    completionOffset: number,
  }): number {
    const relativeBufferOffset = Math.max(
      0,
      Math.min(segment.end - segment.start, completionOffset - segment.start),
    );
    const originalOffset = segment.textOffset + relativeBufferOffset;
    const lineState = segment.lineState;
    if (originalOffset < lineState.lastCompletionOffset) {
      throw new Error(
        `jq input metadata moved backwards from ${lineState.lastCompletionOffset} to ${originalOffset}`,
      );
    }
    while (lineState.nextNewlineOffset >= 0 && lineState.nextNewlineOffset < originalOffset) {
      lineState.completedNewlines += 1;
      lineState.nextNewlineOffset = segment.text.indexOf('\n', lineState.nextNewlineOffset + 1);
    }
    lineState.lastCompletionOffset = originalOffset;
    return lineState.completedNewlines + (lineState.nextNewlineOffset >= originalOffset ? 1 : 0);
  }

  private metadataForCompletion({
    completionOffset,
    boundaryMetadata,
  }: {
    completionOffset: number,
    boundaryMetadata: { readonly filename: string, readonly lineNumber: number } | undefined,
  }): { readonly filename: string, readonly lineNumber: number } {
    if (boundaryMetadata !== undefined) return boundaryMetadata;

    for (const segment of this.sourceSegments) {
      if (completionOffset < segment.start || completionOffset >= segment.end) continue;
      return {
        filename: segment.path,
        lineNumber: this.lineNumberForCompletion({ segment, completionOffset }),
      };
    }

    if (completionOffset === this.sourceText.length && this.lastLoadedPath !== undefined) {
      return {
        filename: this.lastLoadedPath,
        lineNumber: this.lastLoadedLineNumberAtEnd,
      };
    }

    throw new Error(`Cannot resolve jq input metadata at buffer offset ${completionOffset}`);
  }

  private lastSourceBoundaryMetadata(): { readonly filename: string, readonly lineNumber: number } | undefined {
    return this.lastLoadedPath === undefined
      ? undefined
      : { filename: this.lastLoadedPath, lineNumber: this.lastLoadedLineNumberAtEnd };
  }

  private parseAvailableRawInput({
    endOfInput,
    boundaryMetadata,
  }: {
    endOfInput: boolean,
    boundaryMetadata: { readonly filename: string, readonly lineNumber: number } | undefined,
  }): JqAvailableInputResult {
    const newlineIndex = this.sourceText.indexOf('\n', this.sourceIndex);
    if (newlineIndex >= 0) {
      const metadata = this.metadataForCompletion({
        completionOffset: newlineIndex,
        boundaryMetadata: undefined,
      });
      const value = this.sourceText.slice(this.sourceIndex, newlineIndex);
      this.sourceIndex = newlineIndex + 1;
      return {
        kind: 'result',
        result: {
          kind: 'value',
          value,
          filename: metadata.filename,
          lineNumber: metadata.lineNumber,
        },
      };
    }

    if (!endOfInput) {
      const pendingToken = this.sourceIndex < this.sourceText.length;
      const compactIndex = this.sourceIndex;
      this.compactSourceBefore({ index: compactIndex });
      return { kind: 'need_more_input', pendingToken };
    }

    if (this.sourceIndex >= this.sourceText.length) {
      this.compactSourceBefore({ index: this.sourceIndex });
      return { kind: 'exhausted' };
    }

    const metadata = this.metadataForCompletion({
      completionOffset: this.sourceText.length,
      boundaryMetadata,
    });
    const value = this.sourceText.slice(this.sourceIndex);
    this.sourceIndex = this.sourceText.length;
    return {
      kind: 'result',
      result: {
        kind: 'value',
        value,
        filename: metadata.filename,
        lineNumber: metadata.lineNumber,
      },
    };
  }

  private parserErrorRecoveryEnd({
    offset,
  }: {
    offset: number,
  }): number {
    for (const segment of this.sourceSegments) {
      if (offset < segment.start || offset >= segment.end) continue;
      const originalOffset = segment.textOffset + (offset - segment.start);
      const boundaryIndex = segment.parserBufferBoundaries.findIndex(
        boundary => boundary.coveredTextEnd > originalOffset,
      );
      if (boundaryIndex < 0) {
        throw new Error(`Cannot resolve jq parser buffer end at source offset ${offset}`);
      }
      const boundary = segment.parserBufferBoundaries[boundaryIndex]!;
      const lineStart = segment.text.lastIndexOf('\n', Math.max(0, originalOffset - 1)) + 1;
      const originColumn = new TextEncoder().encode(segment.text.slice(lineStart, originalOffset)).byteLength + 1;
      this.pendingUtf8RecoveryToken = boundary.splitsUtf8Sequence
        ? {
          initialTextEnd: segment.start + (boundary.coveredTextEnd - segment.textOffset),
          originColumn,
          tokenByteLength: boundary.continuationByteCount,
        }
        : undefined;
      return segment.start + (boundary.textEnd - segment.textOffset);
    }
    throw new Error(`Cannot resolve jq parser error recovery offset ${offset}`);
  }

  private recoverParserBufferStartingInsideUtf8Sequence({
    endOfInput,
    boundaryMetadata,
  }: {
    endOfInput: boolean,
    boundaryMetadata: { readonly filename: string, readonly lineNumber: number } | undefined,
  }): JqAvailableInputResult | undefined {
    const pending = this.pendingUtf8RecoveryToken;
    if (pending === undefined) return undefined;

    if (pending.initialTextEnd !== undefined) {
      if (pending.initialTextEnd <= this.sourceIndex || pending.initialTextEnd > this.sourceText.length) {
        throw new Error(`Invalid jq split UTF-8 parser recovery start ${pending.initialTextEnd}`);
      }
      this.sourceIndex = pending.initialTextEnd;
      this.pendingUtf8RecoveryToken = {
        initialTextEnd: undefined,
        originColumn: pending.originColumn,
        tokenByteLength: pending.tokenByteLength,
      };
    }

    const active = this.pendingUtf8RecoveryToken;
    if (active === undefined) {
      throw new Error('jq split UTF-8 parser recovery state disappeared');
    }
    let whitespaceIndex = this.sourceIndex;
    while (whitespaceIndex < this.sourceText.length) {
      const character = this.sourceText[whitespaceIndex];
      if (character === undefined || /[\t\n\r ]/u.test(character)) break;
      whitespaceIndex += 1;
    }
    const tokenSuffix = this.sourceText.slice(this.sourceIndex, whitespaceIndex);
    const tokenByteLength = active.tokenByteLength + new TextEncoder().encode(tokenSuffix).byteLength;

    if (whitespaceIndex >= this.sourceText.length) {
      this.sourceIndex = this.sourceText.length;
      if (!endOfInput) {
        this.pendingUtf8RecoveryToken = {
          initialTextEnd: undefined,
          originColumn: active.originColumn,
          tokenByteLength,
        };
        this.compactSourceBefore({ index: this.sourceIndex });
        return { kind: 'need_more_input', pendingToken: true };
      }

      const metadata = this.metadataForCompletion({
        completionOffset: this.sourceText.length,
        boundaryMetadata,
      });
      this.pendingUtf8RecoveryToken = undefined;
      const message = `Invalid numeric literal at EOF at line 1, column ${active.originColumn + tokenByteLength}`;
      return {
        kind: 'result',
        result: {
          kind: 'terminal_error',
          error: {
            message,
            value: message,
            metadata: { filename: metadata.filename, lineNumber: metadata.lineNumber },
          },
        },
      };
    }

    const whitespace = this.sourceText[whitespaceIndex]!;
    const metadata = this.metadataForCompletion({
      completionOffset: whitespaceIndex,
      boundaryMetadata: undefined,
    });
    const recoveryEnd = this.parserErrorRecoveryEnd({ offset: whitespaceIndex });
    this.sourceIndex = recoveryEnd;
    const message = whitespace === '\n'
      ? 'Invalid numeric literal at line 2, column 0'
      : `Invalid numeric literal at line 1, column ${active.originColumn + tokenByteLength + 1}`;
    return {
      kind: 'result',
      result: {
        kind: 'terminal_error',
        error: {
          message,
          value: message,
          metadata: { filename: metadata.filename, lineNumber: metadata.lineNumber },
        },
      },
    };
  }

  private parseAvailableJsonInput({
    endOfInput,
    boundaryMetadata,
  }: {
    endOfInput: boolean,
    boundaryMetadata: { readonly filename: string, readonly lineNumber: number } | undefined,
  }): JqAvailableInputResult {
    const utf8Recovery = this.recoverParserBufferStartingInsideUtf8Sequence({
      endOfInput,
      boundaryMetadata,
    });
    if (utf8Recovery !== undefined) return utf8Recovery;

    const scanned = scanJsonSequenceIncrementally({
      text: this.sourceText,
      start: this.sourceIndex,
      endOfInput,
      errorRecoveryEnd: ({ offset }) => this.parserErrorRecoveryEnd({ offset }),
    });
    switch (scanned.kind) {
    case 'value': {
      const metadata = this.metadataForCompletion({
        completionOffset: scanned.completionOffset,
        boundaryMetadata,
      });
      this.sourceIndex = scanned.nextIndex;
      return {
        kind: 'result',
        result: cursorEntryResult({
          entry: {
            ok: true,
            value: scanned.value,
            filename: metadata.filename,
            lineNumber: metadata.lineNumber,
            ...(scanned.numberOrigin === undefined ? {} : { numberOrigin: scanned.numberOrigin }),
          },
        }),
      };
    }
    case 'error': {
      const metadata = this.metadataForCompletion({
        completionOffset: scanned.completionOffset,
        boundaryMetadata,
      });
      this.sourceIndex = scanned.nextIndex;
      return {
        kind: 'result',
        result: cursorEntryResult({
          entry: {
            ok: false,
            message: scanned.message,
            filename: metadata.filename,
            lineNumber: metadata.lineNumber,
          },
        }),
      };
    }
    case 'need_more_input':
      this.sourceIndex = scanned.nextIndex;
      this.compactSourceBefore({ index: scanned.nextIndex });
      return { kind: 'need_more_input', pendingToken: scanned.pendingToken };
    case 'exhausted':
      this.sourceIndex = scanned.nextIndex;
      this.compactSourceBefore({ index: scanned.nextIndex });
      return { kind: 'exhausted' };
    default: {
      const _ex: never = scanned;
      throw new Error(`Unhandled incremental jq JSON scan result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private parseAvailableInput({
    endOfInput,
    boundaryMetadata,
  }: {
    endOfInput: boolean,
    boundaryMetadata: { readonly filename: string, readonly lineNumber: number } | undefined,
  }): JqAvailableInputResult {
    return this.options.rawInput
      ? this.parseAvailableRawInput({ endOfInput, boundaryMetadata })
      : this.parseAvailableJsonInput({ endOfInput, boundaryMetadata });
  }

  private finalizePendingInputAtBoundary({
    filename,
    lineNumber,
  }: {
    filename: string,
    lineNumber: number,
  }): JqBufferedCursorResult | undefined {
    const finalized = this.parseAvailableInput({
      endOfInput: true,
      boundaryMetadata: { filename, lineNumber },
    });
    switch (finalized.kind) {
    case 'result':
      if (this.sourceIndex === this.sourceText.length) {
        this.compactSourceBefore({ index: this.sourceIndex });
      }
      return finalized.result;
    case 'exhausted':
      return undefined;
    case 'need_more_input':
      throw new Error('jq input remained incomplete after an explicit source boundary');
    default: {
      const _ex: never = finalized;
      throw new Error(`Unhandled jq finalized input result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private async nextUnslurped(): Promise<JqCursorResult> {
    while (true) {
      const buffered = this.bufferedResults[this.bufferedResultIndex];
      if (buffered !== undefined) {
        this.bufferedResultIndex += 1;
        this.compactBufferedResults();
        return buffered;
      }

      const queued = this.queuedResults.shift();
      if (queued !== undefined) return queued;

      const available = this.parseAvailableInput({
        endOfInput: this.sourceExhausted,
        boundaryMetadata: this.sourceExhausted ? this.lastSourceBoundaryMetadata() : undefined,
      });
      switch (available.kind) {
      case 'result':
        return available.result;
      case 'exhausted':
        if (this.sourceExhausted) return { kind: 'exhausted' };
        break;
      case 'need_more_input':
        if (this.sourceExhausted) {
          throw new Error('jq source is exhausted but incremental input still requested more data');
        }
        break;
      default: {
        const _ex: never = available;
        throw new Error(`Unhandled jq available input result: ${JSON.stringify(_ex)}`);
      }
      }

      const pendingToken = available.kind === 'need_more_input' && available.pendingToken;
      const loaded = await this.loadNextPath();
      switch (loaded.kind) {
      case 'loaded':
        this.appendInputSegment({ text: loaded.text, path: loaded.path });
        continue;
      case 'diagnostic': {
        this.lastLoadedPath = loaded.path;
        this.lastLoadedLineNumberAtEnd = 0;
        if (pendingToken) {
          const finalized = this.finalizePendingInputAtBoundary({
            filename: loaded.path,
            lineNumber: 0,
          });
          if (finalized !== undefined) this.queuedResults.push(finalized);
        }
        return { kind: 'diagnostic', message: loaded.message };
      }
      case 'exhausted':
        this.sourceExhausted = true;
        continue;
      default: {
        const _ex: never = loaded;
        throw new Error(`Unhandled jq cursor load result: ${JSON.stringify(_ex)}`);
      }
      }
    }
  }

  private async nextSlurped(): Promise<JqCursorResult> {
    if (this.slurpEmitted) return { kind: 'exhausted' };
    if (!this.slurpComplete) {
      if (this.options.rawInput) {
        while (true) {
          const loaded = await this.loadNextPath();
          switch (loaded.kind) {
          case 'diagnostic':
            this.lastLoadedPath = loaded.path;
            this.lastLoadedLineNumberAtEnd = 0;
            return { kind: 'diagnostic', message: loaded.message };
          case 'exhausted':
            this.slurpComplete = true;
            break;
          case 'loaded': {
            this.slurpedRawFragments.push(loaded.text);
            this.lastLoadedPath = loaded.path;
            this.lastLoadedLineNumberAtEnd = countNewlines({ text: loaded.text, end: loaded.text.length });
            this.slurpedMetadata = {
              filename: loaded.path,
              lineNumber: this.lastLoadedLineNumberAtEnd,
            };
            continue;
          }
          default: {
            const _ex: never = loaded;
            throw new Error(`Unhandled jq slurp load result: ${JSON.stringify(_ex)}`);
          }
          }
          break;
        }
      } else {
        while (true) {
          const next = await this.nextUnslurped();
          switch (next.kind) {
          case 'value': {
            const slurpIndex = this.slurpedValues.length;
            this.slurpedValues.push(next.value);
            setJsonChildNumberOrigin({
              container: this.slurpedValues,
              key: slurpIndex,
              origin: next.numberOrigin,
            });
            this.slurpedMetadata = { filename: next.filename, lineNumber: next.lineNumber };
            continue;
          }
          case 'diagnostic':
          case 'terminal_error':
            return next;
          case 'exhausted':
            this.slurpComplete = true;
            break;
          default: {
            const _ex: never = next;
            throw new Error(`Unhandled jq slurp cursor result: ${JSON.stringify(_ex)}`);
          }
          }
          break;
        }
      }
    }

    this.slurpEmitted = true;
    return {
      kind: 'value',
      value: this.options.rawInput ? this.slurpedRawFragments.join('') : this.slurpedValues,
      filename: this.slurpedMetadata.filename,
      lineNumber: this.slurpedMetadata.lineNumber,
    };
  }
}

function replayOutputValueMatches({
  left,
  right,
  leftOrigin,
  rightOrigin,
}: {
  left: JsonValue,
  right: JsonValue,
  leftOrigin?: JqNumberOrigin,
  rightOrigin?: JqNumberOrigin,
}): boolean {
  const pending: {
    readonly left: JsonValue,
    readonly right: JsonValue,
    readonly leftOrigin?: JqNumberOrigin,
    readonly rightOrigin?: JqNumberOrigin,
  }[] = [{ left, right, leftOrigin, rightOrigin }];

  while (pending.length > 0) {
    const pair = pending.pop()!;
    if (typeof pair.left === 'number' && typeof pair.right === 'number') {
      if (Number.isNaN(pair.left) || Number.isNaN(pair.right)) {
        if (!(Number.isNaN(pair.left) && Number.isNaN(pair.right))) return false;
      } else if (!Object.is(pair.left, pair.right)) {
        return false;
      }

      if (pair.leftOrigin?.canonical !== pair.rightOrigin?.canonical) return false;
      continue;
    }

    if (pair.left === pair.right) continue;
    if (Array.isArray(pair.left) && Array.isArray(pair.right)) {
      if (pair.left.length !== pair.right.length) return false;
      for (let index = 0; index < pair.left.length; index += 1) {
        pending.push({
          left: pair.left[index]!,
          right: pair.right[index]!,
          leftOrigin: getJsonChildNumberOrigin({ container: pair.left, key: index }),
          rightOrigin: getJsonChildNumberOrigin({ container: pair.right, key: index }),
        });
      }
      continue;
    }

    if (
      pair.left !== null
      && pair.right !== null
      && typeof pair.left === 'object'
      && typeof pair.right === 'object'
      && !Array.isArray(pair.left)
      && !Array.isArray(pair.right)
    ) {
      const leftKeys = jsonObjectKeys({ object: pair.left });
      const rightKeys = jsonObjectKeys({ object: pair.right });
      if (leftKeys.length !== rightKeys.length) return false;
      for (let index = 0; index < leftKeys.length; index += 1) {
        const leftKey = leftKeys[index]!;
        const rightKey = rightKeys[index]!;
        if (leftKey !== rightKey) return false;
        pending.push({
          left: pair.left[leftKey]!,
          right: pair.right[rightKey]!,
          leftOrigin: getJsonChildNumberOrigin({ container: pair.left, key: leftKey }),
          rightOrigin: getJsonChildNumberOrigin({ container: pair.right, key: rightKey }),
        });
      }
      continue;
    }

    return false;
  }

  return true;
}

function replayOutputPrefixMatches({
  previous,
  current,
  previousMetadata,
  currentMetadata,
}: {
  previous: readonly JsonValue[],
  current: readonly JsonValue[],
  previousMetadata: readonly JqRuntimeInputMetadata[] | undefined,
  currentMetadata: readonly JqRuntimeInputMetadata[] | undefined,
}): boolean {
  if (previous.length > current.length) return false;
  return previous.every((value, index) => (
    current[index] !== undefined
    && replayOutputValueMatches({
      left: value,
      right: current[index]!,
      leftOrigin: previousMetadata?.[index]?.numberOrigin,
      rightOrigin: currentMetadata?.[index]?.numberOrigin,
    })
  ));
}

function replayTextPrefixMatches({
  previous,
  current,
}: {
  previous: readonly string[],
  current: readonly string[],
}): boolean {
  if (previous.length > current.length) return false;
  return previous.every((value, index) => current[index] === value);
}

function parseSingleJson({
  source,
  label,
}: {
  source: string,
  label: string,
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  const parsed = parseJsonSequence({ text: source });
  if (!parsed.ok) return { ok: false, message: `${label}: ${parsed.message}` };
  if (parsed.values.length !== 1) {
    return { ok: false, message: `${label}: expected exactly one JSON value` };
  }
  return { ok: true, value: parsed.values[0]! };
}

function createArgsVariable({
  named,
  positional,
}: {
  named: { [key: string]: JsonValue },
  positional: JsonValue[],
}): JsonValue {
  const args = createJsonObject();
  defineJsonProperty({ object: args, key: 'positional', value: positional });
  defineJsonProperty({ object: args, key: 'named', value: named });
  return args;
}

async function resolveVariables({
  context,
  injectedArguments,
  positionalArguments,
  jsonArguments,
}: {
  context: WeshCommandContext,
  injectedArguments: readonly JqInjectedArgument[],
  positionalArguments: readonly string[],
  jsonArguments: boolean,
}): Promise<
  | { ok: true, variables: Readonly<Record<string, JsonValue>> }
  | { ok: false, message: string }
> {
  const variables = createJsonObject();
  const named = createJsonObject();

  for (const argument of injectedArguments) {
    let value: JsonValue;
    switch (argument.kind) {
    case 'string':
      value = argument.value;
      break;
    case 'json': {
      const parsed = parseSingleJson({
        source: argument.value,
        label: `jq: invalid JSON text passed to --argjson ${argument.name}`,
      });
      if (!parsed.ok) return parsed;
      value = parsed.value;
      break;
    }
    case 'rawfile': {
      const loaded = await readPathText({ context, path: argument.value });
      if (!loaded.ok) return loaded;
      value = loaded.text;
      break;
    }
    case 'slurpfile': {
      const loaded = await readPathText({ context, path: argument.value });
      if (!loaded.ok) return loaded;
      const parsed = parseJsonSequence({ text: loaded.text });
      if (!parsed.ok) {
        return { ok: false, message: `jq: ${argument.value}: ${parsed.message}` };
      }
      value = parsed.values;
      break;
    }
    default: {
      const _ex: never = argument.kind;
      throw new Error(`Unhandled jq injected argument: ${_ex}`);
    }
    }

    defineJsonProperty({ object: variables, key: argument.name, value });
    defineJsonProperty({ object: named, key: argument.name, value });
  }

  const positional: JsonValue[] = [];
  for (const argument of positionalArguments) {
    if (!jsonArguments) {
      positional.push(argument);
      continue;
    }
    const parsed = parseSingleJson({ source: argument, label: 'jq: invalid JSON text passed to --jsonargs' });
    if (!parsed.ok) return parsed;
    positional.push(parsed.value);
  }

  const environment = createJsonObject();
  for (const [key, value] of context.env) {
    defineJsonProperty({ object: environment, key, value });
  }
  defineJsonProperty({ object: variables, key: 'ENV', value: environment });
  defineJsonProperty({
    object: variables,
    key: 'ARGS',
    value: createArgsVariable({ named, positional }),
  });
  return { ok: true, variables };
}

function resolveOutputIndentation({
  occurrences,
  indentValue,
}: {
  occurrences: readonly { option: string }[],
  indentValue: boolean | string | number | undefined,
}): number | '\t' {
  let indentation: number | '\t' = 2;
  for (const occurrence of occurrences) {
    if (occurrence.option === '--tab') indentation = '\t';
    if (occurrence.option === '--indent' && typeof indentValue === 'number') {
      indentation = indentValue === -1 ? '\t' : indentValue;
    }
  }
  return indentation;
}

type JqArgumentMode = 'files' | 'strings' | 'json';

function resolveArgumentMode({
  occurrences,
}: {
  occurrences: readonly { option: string }[],
}): JqArgumentMode {
  let mode: JqArgumentMode = 'files';
  for (const occurrence of occurrences) {
    if (occurrence.option === '--args') mode = 'strings';
    if (occurrence.option === '--jsonargs') mode = 'json';
  }
  return mode;
}

function resolveArgumentConfiguration({
  mode,
  operands,
}: {
  mode: JqArgumentMode,
  operands: string[],
}): {
  positionalArguments: string[],
  jsonArguments: boolean,
  inputPaths: string[],
} {
  switch (mode) {
  case 'files':
    return {
      positionalArguments: [],
      jsonArguments: false,
      inputPaths: operands.length > 0 ? operands : ['-'],
    };
  case 'strings':
    return {
      positionalArguments: operands,
      jsonArguments: false,
      inputPaths: ['-'],
    };
  case 'json':
    return {
      positionalArguments: operands,
      jsonArguments: true,
      inputPaths: ['-'],
    };
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled jq argument mode: ${_ex}`);
  }
  }
}

function filterUsesInputs({
  filter,
  userDefinitions,
}: {
  filter: JqFilter,
  userDefinitions: readonly JqUserDefinition[],
}): boolean {
  type InputScanTask =
    | { readonly kind: 'filter', readonly value: JqFilter }
    | { readonly kind: 'path', readonly value: JqPathExpression };

  const definitionsById = new Map(userDefinitions.map((definition) => [definition.id, definition]));
  const visitedDefinitionIds = new Set<number>();
  const pending: InputScanTask[] = [{ kind: 'filter', value: filter }];
  while (pending.length > 0) {
    const task = pending.pop()!;
    switch (task.kind) {
    case 'path':
      switch (task.value.kind) {
      case 'path':
        break;
      case 'sequence':
        for (const item of task.value.items) pending.push({ kind: 'path', value: item });
        break;
      case 'append':
      case 'iterate':
        pending.push({ kind: 'path', value: task.value.parent });
        break;
      case 'dynamic_index':
        pending.push({ kind: 'path', value: task.value.parent });
        pending.push({ kind: 'filter', value: task.value.index });
        break;
      case 'dynamic_slice':
        pending.push({ kind: 'path', value: task.value.parent });
        if (task.value.start !== undefined) pending.push({ kind: 'filter', value: task.value.start });
        if (task.value.end !== undefined) pending.push({ kind: 'filter', value: task.value.end });
        break;
      default: {
        const _ex: never = task.value;
        throw new Error(`Unhandled jq path expression: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    case 'filter':
      switch (task.value.kind) {
      case 'identity':
      case 'variable':
      case 'literal':
        break;
      case 'string':
        for (const part of task.value.parts) {
          switch (part.kind) {
          case 'text':
            break;
          case 'interpolation':
            pending.push({ kind: 'filter', value: part.filter });
            break;
          default: {
            const _ex: never = part;
            throw new Error(`Unhandled jq string part: ${JSON.stringify(_ex)}`);
          }
          }
        }
        break;
      case 'array':
        for (const item of task.value.items) pending.push({ kind: 'filter', value: item });
        break;
      case 'object':
        for (const entry of task.value.entries) {
          switch (entry.key.kind) {
          case 'static':
            break;
          case 'dynamic':
            pending.push({ kind: 'filter', value: entry.key.filter });
            break;
          default: {
            const _ex: never = entry.key;
            throw new Error(`Unhandled jq object key: ${JSON.stringify(_ex)}`);
          }
          }
          pending.push({ kind: 'filter', value: entry.value });
        }
        break;
      case 'field':
      case 'index':
      case 'iterate':
      case 'recursive_descent':
        pending.push({ kind: 'filter', value: task.value.input });
        break;
      case 'dynamic_index':
        pending.push({ kind: 'filter', value: task.value.input });
        pending.push({ kind: 'filter', value: task.value.index });
        break;
      case 'slice':
        pending.push({ kind: 'filter', value: task.value.input });
        if (task.value.start !== undefined) pending.push({ kind: 'filter', value: task.value.start });
        if (task.value.end !== undefined) pending.push({ kind: 'filter', value: task.value.end });
        break;
      case 'optional':
        pending.push({ kind: 'filter', value: task.value.body });
        break;
      case 'pipe':
      case 'comma':
      case 'binary':
        pending.push({ kind: 'filter', value: task.value.left });
        pending.push({ kind: 'filter', value: task.value.right });
        break;
      case 'conditional':
        pending.push({ kind: 'filter', value: task.value.condition });
        pending.push({ kind: 'filter', value: task.value.thenBranch });
        pending.push({ kind: 'filter', value: task.value.elseBranch });
        break;
      case 'trycatch':
        pending.push({ kind: 'filter', value: task.value.body });
        pending.push({ kind: 'filter', value: task.value.catchBranch });
        break;
      case 'call':
        if (task.value.name === 'input' || task.value.name === 'inputs') return true;
        for (const argument of task.value.args) pending.push({ kind: 'filter', value: argument });
        break;
      case 'user_call': {
        for (const argument of task.value.args) pending.push({ kind: 'filter', value: argument });
        if (visitedDefinitionIds.has(task.value.definitionId)) break;
        visitedDefinitionIds.add(task.value.definitionId);
        const definition = definitionsById.get(task.value.definitionId);
        if (definition !== undefined) pending.push({ kind: 'filter', value: definition.body });
        break;
      }
      case 'unresolved_user_call':
        for (const argument of task.value.args) pending.push({ kind: 'filter', value: argument });
        break;
      case 'unary':
        pending.push({ kind: 'filter', value: task.value.value });
        break;
      case 'break':
        break;
      case 'label':
        pending.push({ kind: 'filter', value: task.value.body });
        break;
      case 'bind':
        pending.push({ kind: 'filter', value: task.value.binding });
        pending.push({ kind: 'filter', value: task.value.body });
        break;
      case 'reduce':
        pending.push({ kind: 'filter', value: task.value.generator });
        pending.push({ kind: 'filter', value: task.value.initial });
        pending.push({ kind: 'filter', value: task.value.update });
        break;
      case 'foreach':
        pending.push({ kind: 'filter', value: task.value.generator });
        pending.push({ kind: 'filter', value: task.value.initial });
        pending.push({ kind: 'filter', value: task.value.update });
        pending.push({ kind: 'filter', value: task.value.extract });
        break;
      case 'assign':
      case 'update':
        pending.push({ kind: 'path', value: task.value.pathExpression });
        pending.push({ kind: 'filter', value: task.value.value });
        break;
      default: {
        const _ex: never = task.value;
        throw new Error(`Unhandled jq filter: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    default: {
      const _ex: never = task;
      throw new Error(`Unhandled jq input scan task: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return false;
}

async function finishRuntimeHalt({
  context,
  stdout,
  halt,
}: {
  context: WeshCommandContext,
  stdout: BufferedStdout,
  halt: NonNullable<JqRuntimeError['halt']>,
}): Promise<WeshCommandResult> {
  await stdout.flush();
  if (halt.stderr.length > 0) await context.text().error({ text: halt.stderr });
  return { exitCode: halt.exitCode };
}

async function writeRuntimeError({
  context,
  stdout,
  message,
  metadata,
}: {
  context: WeshCommandContext,
  stdout: BufferedStdout,
  message: string,
  metadata: JqRuntimeInputMetadata | undefined,
}): Promise<WeshCommandResult> {
  await stdout.flush();
  const includeInputLocation = message.startsWith('Regex failure:')
    || message.startsWith('Invalid numeric literal')
    || message === 'Out of bounds negative array index';
  const inputLocation = includeInputLocation
    ? metadata === undefined
      ? '<unknown>'
      : metadata.filename === null
        ? metadata.lineNumber > 0
          ? `<stdin>:${metadata.lineNumber}`
          : '<unknown>'
        : `${metadata.filename}:${metadata.lineNumber}`
    : undefined;
  await context.text().error({
    text: message.startsWith('parse error:')
      ? `jq: ${message}
`
      : inputLocation === undefined
        ? `jq: error: ${message}
`
        : `jq: error (at ${inputLocation}): ${message}
`,
  });
  return { exitCode: 5 };
}

export const jqCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedJq = parseJqArgv({ args: context.args });
    const parsed = parsedJq.standard;

    if (parsedJq.earlyExit !== undefined) {
      // jq validates semantic injected values that precede help/version before
      // honoring the early exit. In particular, invalid --argjson JSON and
      // unreadable --rawfile/--slurpfile paths remain errors, while -f filter
      // files are deliberately not opened before a later early-exit sentinel.
      const earlyArgumentConfiguration = resolveArgumentConfiguration({
        mode: resolveArgumentMode({ occurrences: parsed.occurrences }),
        // Help/version suppress filter parsing and -f file loading, but jq has
        // already interpreted operands after the filter source according to
        // --args/--jsonargs. Invalid --jsonargs JSON therefore remains an
        // error before the later early-exit sentinel.
        operands: parsed.positionals.slice(1),
      });
      const earlyExitVariables = await resolveVariables({
        context,
        injectedArguments: parsedJq.injectedArguments,
        positionalArguments: earlyArgumentConfiguration.positionalArguments,
        jsonArguments: earlyArgumentConfiguration.jsonArguments,
      });
      if (!earlyExitVariables.ok) {
        await context.text().error({ text: `${earlyExitVariables.message}
` });
        return { exitCode: 2 };
      }

      switch (parsedJq.earlyExit) {
      case 'help':
        await writeCommandHelp({
          context,
          command: 'jq',
          argvSpec: jqArgvSpec,
        });
        return { exitCode: 0 };
      case 'version':
        await context.text().print({ text: `${JQ_WESH_VERSION}\n` });
        return { exitCode: 0 };
      default: {
        const _ex: never = parsedJq.earlyExit;
        throw new Error(`Unhandled jq early exit: ${_ex}`);
      }
      }
    }

    const diagnostic = parsedJq.grammarDiagnostic ?? parsed.diagnostics[0]?.message;
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'jq',
        message: `jq: ${diagnostic}`,
        argvSpec: jqArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (optionBoolean({ optionValues: parsed.optionValues, key: 'help' })) {
      await writeCommandHelp({
        context,
        command: 'jq',
        argvSpec: jqArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (optionBoolean({ optionValues: parsed.optionValues, key: 'version' })) {
      await context.text().print({ text: `${JQ_WESH_VERSION}\n` });
      return { exitCode: 0 };
    }

    let filterSource: string;
    let operands: string[];
    if (parsedJq.filterFromFile) {
      const filterFile = parsed.positionals[0] ?? '.';
      const loaded = await readPathText({ context, path: filterFile });
      if (!loaded.ok) {
        await context.text().error({ text: `${loaded.message}\n` });
        return { exitCode: 2 };
      }
      filterSource = loaded.text;
      operands = parsed.positionals.slice(1);
    } else {
      const positionalFilter = parsed.positionals[0];
      if (positionalFilter === undefined) {
        await writeCommandUsageError({
          context,
          command: 'jq',
          message: 'jq: missing filter',
          argvSpec: jqArgvSpec,
        });
        return { exitCode: 2 };
      }
      filterSource = positionalFilter;
      operands = parsed.positionals.slice(1);
    }

    const program = parseJqProgram({ source: filterSource });
    if (!program.ok) {
      await context.text().error({ text: `jq: parse error: ${program.message}\n` });
      return { exitCode: 3 };
    }

    const argumentMode = resolveArgumentMode({ occurrences: parsed.occurrences });
    const argumentConfiguration = resolveArgumentConfiguration({
      mode: argumentMode,
      operands,
    });
    const variables = await resolveVariables({
      context,
      injectedArguments: parsedJq.injectedArguments,
      positionalArguments: argumentConfiguration.positionalArguments,
      jsonArguments: argumentConfiguration.jsonArguments,
    });
    if (!variables.ok) {
      await context.text().error({ text: `${variables.message}\n` });
      return { exitCode: 2 };
    }

    const compiled = validateJqProgram({
      program: program.program,
      variables: Object.keys(variables.variables),
    });
    if (!compiled.ok) {
      await context.text().error({ text: `jq: error: ${compiled.message}\n` });
      return { exitCode: 3 };
    }

    const inputOptions: JqInputOptions = {
      nullInput: optionBoolean({ optionValues: parsed.optionValues, key: 'nullInput' }),
      rawInput: optionBoolean({ optionValues: parsed.optionValues, key: 'rawInput' }),
      slurp: optionBoolean({ optionValues: parsed.optionValues, key: 'slurp' }),
    };
    const rawOutput0 = optionBoolean({ optionValues: parsed.optionValues, key: 'rawOutput0' });
    const outputOptions: JqOutputOptions = {
      compact: optionBoolean({ optionValues: parsed.optionValues, key: 'compactOutput' }),
      raw: rawOutput0 || optionBoolean({ optionValues: parsed.optionValues, key: 'rawOutput' }),
      join: optionBoolean({ optionValues: parsed.optionValues, key: 'joinOutput' }),
      asciiOnly: optionBoolean({ optionValues: parsed.optionValues, key: 'asciiOutput' }),
      sortKeys: optionBoolean({ optionValues: parsed.optionValues, key: 'sortKeys' }),
      indentation: resolveOutputIndentation({
        occurrences: parsed.occurrences,
        indentValue: parsed.optionValues.indent,
      }),
      nullSeparator: rawOutput0,
      unbuffered: optionBoolean({ optionValues: parsed.optionValues, key: 'unbuffered' }),
    };

    const stdout = new BufferedStdout({ context });
    let hadOutput = false;
    let lastOutput: JsonValue | undefined;
    let lastRuntimeExitCode: 0 | 5 | undefined;

    const writeOutputs = async ({
      outputs,
      outputMetadata,
      startIndex,
    }: {
      outputs: readonly JsonValue[],
      outputMetadata: readonly JqRuntimeInputMetadata[] | undefined,
      startIndex: number,
    }): Promise<void> => {
      for (let index = startIndex; index < outputs.length; index += 1) {
        const output = outputs[index]!;
        hadOutput = true;
        lastOutput = output;
        await stdout.write({
          text: formatJsonOutput({
            value: output,
            compact: outputOptions.compact,
            raw: outputOptions.raw,
            join: outputOptions.join,
            asciiOnly: outputOptions.asciiOnly,
            sortKeys: outputOptions.sortKeys,
            indentation: outputOptions.indentation,
            nullSeparator: outputOptions.nullSeparator,
            numberOrigin: outputMetadata?.[index]?.numberOrigin,
          }),
          flush: outputOptions.unbuffered,
        });
      }
    };

    const evaluateInput = async ({
      value,
      metadata,
      inputState,
    }: {
      value: JsonValue,
      metadata: JqRuntimeInputMetadata,
      inputState?: JqRuntimeInputState,
    }): Promise<WeshCommandResult | undefined> => {
      const result = evaluateJqFilter({
        filter: program.program.filter,
        input: value,
        variables: variables.variables,
        inputState: inputState ?? {
          entries: [],
          index: 0,
          currentMetadata: metadata,
          sourceExhausted: true,
          terminalError: undefined,
        },
        userDefinitions: program.program.userDefinitions,
      });
      const stderr = result.stderr ?? [];
      for (const text of stderr) await context.text().error({ text });
      const outputs = result.ok ? result.outputs : failureOutputs({ result });
      await writeOutputs({ outputs, outputMetadata: result.outputMetadata, startIndex: 0 });
      if (result.ok) {
        lastRuntimeExitCode = 0;
        return undefined;
      }
      if (result.error.halt !== undefined) {
        return finishRuntimeHalt({ context, stdout, halt: result.error.halt });
      }
      await writeRuntimeError({
        context,
        stdout,
        message: result.error.message,
        metadata: result.error.metadata ?? metadata,
      });
      lastRuntimeExitCode = 5;
      return undefined;
    };

    const usesInputs = filterUsesInputs({
      filter: program.program.filter,
      userDefinitions: program.program.userDefinitions,
    });

    if (usesInputs) {
      const cursor = new JqInputCursor({
        context,
        paths: argumentConfiguration.inputPaths,
        options: inputOptions,
      });
      let inputExitCode = 0;

      const writeInputDiagnostic = async ({
        message,
      }: {
        message: string,
      }): Promise<void> => {
        await stdout.flush();
        await context.text().error({ text: `${message}
` });
        inputExitCode = 2;
      };

      const evaluateWithDemand = async ({
        entry,
      }: {
        entry: JqRuntimeInputEntry,
      }): Promise<WeshCommandResult | undefined> => {
        const demandedInputs: JqRuntimeInputEntry[] = [];
        const demandedInputErrors = new Set<JqRuntimeError>();
        let sourceExhausted = false;
        let emittedOutputs: readonly JsonValue[] = [];
        let emittedOutputMetadata: readonly JqRuntimeInputMetadata[] | undefined;
        let emittedStderr: readonly string[] = [];
        let allowBufferedLookahead = false;

        while (true) {
          const replayInputCount = demandedInputs.length;
          // Grow the replay window geometrically from the already consumed
          // prefix. The first demand still reads exactly what the runtime asks
          // for; subsequent replays can then roughly double the available
          // prefix without a fixed cap reintroducing quadratic full-filter work.
          const lookaheadValueLimit = Math.max(replayInputCount, 1);
          const lookaheadValues = allowBufferedLookahead
            ? cursor.peekAvailableValues({ maximumValues: lookaheadValueLimit })
            : [];
          for (const result of lookaheadValues) {
            demandedInputs.push(runtimeInputEntryForCursorValue({ result }));
          }
          const primaryMetadata: JqRuntimeInputMetadata = {
            filename: entry.filename,
            lineNumber: entry.lineNumber,
            ...(entry.numberOrigin === undefined ? {} : { numberOrigin: entry.numberOrigin }),
          };
          const inputState: JqRuntimeInputState = {
            entries: demandedInputs,
            index: 0,
            currentMetadata: primaryMetadata,
            sourceExhausted,
            ...(inputOptions.slurp ? { sourceExhaustionMetadata: primaryMetadata } : {}),
            terminalError: undefined,
          };
          const result = evaluateJqFilter({
            filter: program.program.filter,
            input: entry.value,
            variables: variables.variables,
            inputState,
            userDefinitions: program.program.userDefinitions,
          });
          if (inputState.index < replayInputCount) {
            return writeRuntimeError({
              context,
              stdout,
              message: 'demand-driven input replay consumed a divergent input prefix',
              metadata: entry,
            });
          }
          const consumedLookaheadCount = inputState.index - replayInputCount;
          if (consumedLookaheadCount > lookaheadValues.length) {
            throw new Error(
              `jq demand replay consumed ${consumedLookaheadCount} buffered values with only ${lookaheadValues.length} available`,
            );
          }
          cursor.commitPeekedValues({ count: consumedLookaheadCount });
          demandedInputs.length = replayInputCount + consumedLookaheadCount;
          const stderr = result.stderr ?? [];
          if (!replayTextPrefixMatches({ previous: emittedStderr, current: stderr })) {
            return writeRuntimeError({
              context,
              stdout,
              message: 'demand-driven input replay produced a divergent stderr prefix',
              metadata: entry,
            });
          }
          for (let index = emittedStderr.length; index < stderr.length; index += 1) {
            await context.text().error({ text: stderr[index]! });
          }
          emittedStderr = stderr;
          const outputs = result.ok ? result.outputs : failureOutputs({ result });
          if (!replayOutputPrefixMatches({
            previous: emittedOutputs,
            current: outputs,
            previousMetadata: emittedOutputMetadata,
            currentMetadata: result.outputMetadata,
          })) {
            return writeRuntimeError({
              context,
              stdout,
              message: 'demand-driven input replay produced a divergent output prefix',
              metadata: entry,
            });
          }
          await writeOutputs({
            outputs,
            outputMetadata: result.outputMetadata,
            startIndex: emittedOutputs.length,
          });
          emittedOutputs = outputs;
          emittedOutputMetadata = result.outputMetadata;

          if (result.ok) {
            lastRuntimeExitCode = 0;
            return undefined;
          }
          if (result.error.halt !== undefined) {
            return finishRuntimeHalt({ context, stdout, halt: result.error.halt });
          }
          const request = result.inputRequest;
          if (request === undefined) {
            if (demandedInputErrors.has(result.error)) {
              const failure = await writeRuntimeError({
                context,
                stdout,
                message: result.error.message,
                metadata: result.error.metadata ?? entry,
              });
              return inputExitCode === 0 ? failure : { exitCode: inputExitCode };
            }
            await writeRuntimeError({
              context,
              stdout,
              message: result.error.message,
              metadata: result.error.metadata ?? entry,
            });
            lastRuntimeExitCode = 5;
            return undefined;
          }

          // An unbounded `inputs` request cannot complete before EOF. Drain the
          // finite source once instead of replaying the entire prefix in batches.
          const requestedCount = request.maximumValues;
          allowBufferedLookahead = requestedCount !== undefined;
          let addedValueCount = 0;
          let sourceStateChanged = false;
          while (requestedCount === undefined || addedValueCount < Math.max(requestedCount, 1)) {
            const next = await cursor.next();
            switch (next.kind) {
            case 'value':
              demandedInputs.push({
                value: next.value,
                filename: next.filename,
                lineNumber: next.lineNumber,
                ...(next.numberOrigin === undefined ? {} : { numberOrigin: next.numberOrigin }),
              });
              addedValueCount += 1;
              sourceStateChanged = true;
              break;
            case 'diagnostic':
              await writeInputDiagnostic({ message: next.message });
              sourceStateChanged = true;
              continue;
            case 'terminal_error':
              demandedInputs.push({
                value: null,
                filename: next.error.metadata?.filename ?? null,
                lineNumber: next.error.metadata?.lineNumber ?? 0,
                error: next.error,
              });
              demandedInputErrors.add(next.error);
              sourceStateChanged = true;
              break;
            case 'exhausted':
              sourceExhausted = true;
              sourceStateChanged = true;
              break;
            default: {
              const _ex: never = next;
              throw new Error(`Unhandled jq cursor result: ${JSON.stringify(_ex)}`);
            }
            }
            if (sourceExhausted || next.kind === 'terminal_error') break;
          }

          if (!sourceStateChanged) {
            return writeRuntimeError({
              context,
              stdout,
              message: 'demand-driven input evaluation made no progress',
              metadata: entry,
            });
          }
        }
      };

      if (inputOptions.nullInput) {
        const failed = await evaluateWithDemand({
          entry: { value: null, filename: null, lineNumber: 0 },
        });
        if (failed !== undefined) return failed;
      } else {
        while (true) {
          const next = await cursor.next();
          let exhausted = false;
          switch (next.kind) {
          case 'value': {
            const failed = await evaluateWithDemand({
              entry: {
                value: next.value,
                filename: next.filename,
                lineNumber: next.lineNumber,
                ...(next.numberOrigin === undefined ? {} : { numberOrigin: next.numberOrigin }),
              },
            });
            if (failed !== undefined) return failed;
            break;
          }
          case 'diagnostic':
            await writeInputDiagnostic({ message: next.message });
            break;
          case 'terminal_error': {
            const failure = await writeRuntimeError({
              context,
              stdout,
              message: next.error.message,
              metadata: next.error.metadata,
            });
            return inputExitCode === 0 ? failure : { exitCode: inputExitCode };
          }
          case 'exhausted':
            if (inputExitCode !== 0) {
              await stdout.flush();
              return { exitCode: inputExitCode };
            }
            exhausted = true;
            break;
          default: {
            const _ex: never = next;
            throw new Error(`Unhandled jq top-level cursor result: ${JSON.stringify(_ex)}`);
          }
          }
          if (exhausted) break;
        }
      }

      if (inputExitCode !== 0) {
        await stdout.flush();
        return { exitCode: inputExitCode };
      }
    } else if (inputOptions.nullInput) {
      const failed = await evaluateInput({
        value: null,
        metadata: { filename: null, lineNumber: 0 },
      });
      if (failed !== undefined) return failed;
    } else {
      const cursor = new JqInputCursor({
        context,
        paths: argumentConfiguration.inputPaths,
        options: inputOptions,
      });
      let inputExitCode = 0;

      while (true) {
        const next = await cursor.next();
        let exhausted = false;
        switch (next.kind) {
        case 'value': {
          const failed = await evaluateInput({
            value: next.value,
            metadata: {
              filename: next.filename,
              lineNumber: next.lineNumber,
              ...(next.numberOrigin === undefined ? {} : { numberOrigin: next.numberOrigin }),
            },
          });
          if (failed !== undefined) return failed;
          break;
        }
        case 'diagnostic':
          await stdout.flush();
          await context.text().error({ text: `${next.message}\n` });
          inputExitCode = 2;
          break;
        case 'terminal_error': {
          const failure = await writeRuntimeError({
            context,
            stdout,
            message: next.error.message,
            metadata: next.error.metadata,
          });
          return inputExitCode === 0 ? failure : { exitCode: inputExitCode };
        }
        case 'exhausted':
          if (inputExitCode !== 0) {
            await stdout.flush();
            return { exitCode: inputExitCode };
          }
          exhausted = true;
          break;
        default: {
          const _ex: never = next;
          throw new Error(`Unhandled jq top-level input result: ${JSON.stringify(_ex)}`);
        }
        }
        if (exhausted) break;
      }
    }

    await stdout.flush();
    if (lastRuntimeExitCode === 5) return { exitCode: 5 };
    if (!optionBoolean({ optionValues: parsed.optionValues, key: 'exitStatus' })) {
      return { exitCode: 0 };
    }
    if (!hadOutput) return { exitCode: 4 };
    return { exitCode: lastOutput === false || lastOutput === null ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
