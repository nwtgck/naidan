import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshEntryRef,
} from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { readAllFileBytes, readAllHandleBytes } from '@/features/wesh/utils/fs';
import { getRgOptionHelp, getRgUsageSummary, parseRgArgv, type RgParsedArgv } from './argv';
import { compileRgGlobRule, matchesRgGlobRules, type RgGlobRule } from './glob';
import { isIgnoredByRgRules, parseRgIgnoreFile, type RgIgnoreRule } from './ignore';
import { compileRgTypeRules, getRgTypeListText } from './file-types';
import { createRgLineReader, type RgInputLine } from './lines';

const RG_BINARY_SCAN_LIMIT = 64 * 1024;
const RG_INPUT_CHUNK_LENGTH = 256 * 1024;
const RG_OUTPUT_BUFFER_LENGTH = 4096;
const RG_VERSION_TEXT = 'ripgrep 14.1.1 (Wesh compatible subset)\n';

interface RgSearchFile {
  readonly fullPath: string,
  readonly displayPath: string,
}

interface RgLineMatch {
  readonly selected: boolean,
  readonly ranges: readonly { readonly start: number, readonly end: number }[],
}

interface RgCompiledPattern {
  readonly matchLine: ({ line }: { line: string }) => RgLineMatch,
}

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function joinDisplayPath({ parent, name }: { parent: string, name: string }): string {
  if (parent === '.') {
    return `./${name}`;
  }
  if (parent === '/') {
    return `/${name}`;
  }
  return `${parent.replace(/\/$/, '')}/${name}`;
}

function joinRelativePath({ parent, name }: { parent: string, name: string }): string {
  if (parent.length === 0) {
    return name;
  }
  return `${parent}/${name}`;
}

function basename({ path }: { path: string }): string {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function asDirectoryEntry({ entry }: { entry: WeshEntryRef }): WeshEntryRef<'directory'> {
  switch (entry.type) {
  case 'directory':
    return entry;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Not a directory: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled rg entry type: ${JSON.stringify(_ex)}`);
  }
  }
}

function shouldIgnoreCase({ options }: { options: RgParsedArgv }): boolean {
  switch (options.caseMode) {
  case 'sensitive':
    return false;
  case 'insensitive':
    return true;
  case 'smart':
    return options.pattern === undefined || options.pattern.toLocaleLowerCase() === options.pattern;
  default: {
    const _ex: never = options.caseMode;
    throw new Error(`Unhandled rg case mode: ${JSON.stringify(_ex)}`);
  }
  }
}

const RG_WORD_CHARACTER = /^[\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}\u200C\u200D]$/u;

function isWordBoundaryRange({ line, start, end }: { line: string, start: number, end: number }): boolean {
  const before = start === 0 ? undefined : [...line.slice(0, start)].at(-1);
  const after = end >= line.length ? undefined : [...line.slice(end)].at(0);
  return (before === undefined || !RG_WORD_CHARACTER.test(before))
    && (after === undefined || !RG_WORD_CHARACTER.test(after));
}

function applyWordBoundary({ options, line, ranges }: {
  options: RgParsedArgv,
  line: string,
  ranges: readonly { readonly start: number, readonly end: number }[],
}): readonly { readonly start: number, readonly end: number }[] {
  if (!options.wordRegexp) {
    return ranges;
  }
  return ranges.filter((range) => isWordBoundaryRange({ line, start: range.start, end: range.end }));
}

function compilePattern({ options }: { options: RgParsedArgv }): RgCompiledPattern {
  const pattern = options.pattern ?? '';
  if (options.fixedStrings) {
    const ignoreCase = shouldIgnoreCase({ options });
    const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
    return {
      matchLine: ({ line }: { line: string }): RgLineMatch => {
        const haystack = ignoreCase ? line.toLocaleLowerCase() : line;
        const ranges: { start: number, end: number }[] = [];
        if (options.lineRegexp) {
          const candidateRanges = haystack === needle ? [{ start: 0, end: line.length }] : [];
          const ranges = applyWordBoundary({ options, line, ranges: candidateRanges });
          const rawSelected = ranges.length > 0;
          return {
            selected: options.invertMatch ? !rawSelected : rawSelected,
            ranges,
          };
        }
        if (needle.length === 0) {
          ranges.push({ start: 0, end: 0 });
        } else {
          let offset = 0;
          while (offset <= haystack.length) {
            const index = haystack.indexOf(needle, offset);
            if (index === -1) {
              break;
            }
            ranges.push({ start: index, end: index + needle.length });
            offset = index + needle.length;
          }
        }
        const boundedRanges = applyWordBoundary({ options, line, ranges });
        const rawSelected = boundedRanges.length > 0;
        return { selected: options.invertMatch ? !rawSelected : rawSelected, ranges: boundedRanges };
      },
    };
  }

  const source = options.lineRegexp ? `^(?:${pattern})$` : pattern;
  const ignoreCase = shouldIgnoreCase({ options });
  let regex: RegExp;
  try {
    regex = new RegExp(source, `gu${ignoreCase ? 'i' : ''}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`regex parse error: ${message}`);
  }
  return {
    matchLine: ({ line }: { line: string }): RgLineMatch => {
      regex.lastIndex = 0;
      const ranges: { start: number, end: number }[] = [];
      while (true) {
        const match = regex.exec(line);
        if (match === null) {
          break;
        }
        ranges.push({ start: match.index, end: match.index + match[0].length });
        if (match[0].length === 0) {
          const next = line.codePointAt(regex.lastIndex);
          regex.lastIndex += next !== undefined && next > 0xffff ? 2 : 1;
          if (regex.lastIndex > line.length) {
            break;
          }
        }
      }
      const boundedRanges = applyWordBoundary({ options, line, ranges });
      const rawSelected = boundedRanges.length > 0;
      return { selected: options.invertMatch ? !rawSelected : rawSelected, ranges: boundedRanges };
    },
  };
}

function findNulOffset({ bytes }: { bytes: Uint8Array }): number | undefined {
  const limit = Math.min(bytes.length, RG_BINARY_SCAN_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return index;
    }
  }
  return undefined;
}

async function tryReadIgnoreFile({
  context,
  directoryPath,
  relativeDirectoryPath,
  name,
  noMessages,
}: {
  context: WeshCommandContext,
  directoryPath: string,
  relativeDirectoryPath: string,
  name: string,
  noMessages: boolean,
}): Promise<readonly RgIgnoreRule[]> {
  const path = directoryPath === '/' ? `/${name}` : `${directoryPath}/${name}`;
  try {
    const bytes = await readAllFileBytes({ files: context.files, path });
    const parsed = parseRgIgnoreFile({ text: new TextDecoder().decode(bytes), basePath: relativeDirectoryPath });
    if (!noMessages) {
      for (const diagnostic of parsed.diagnostics) {
        await context.text().error({ text: `rg: ${path}: line ${diagnostic.lineNumber}: ${diagnostic.message}\n` });
      }
    }
    return parsed.rules;
  } catch {
    return [];
  }
}

async function readExplicitIgnoreRules({
  context,
  paths,
  noMessages,
}: {
  context: WeshCommandContext,
  paths: readonly string[],
  noMessages: boolean,
}): Promise<readonly RgIgnoreRule[]> {
  const rules: RgIgnoreRule[] = [];
  for (const path of paths) {
    const fullPath = resolvePath({ cwd: context.cwd, path });
    try {
      const bytes = await readAllFileBytes({ files: context.files, path: fullPath });
      const parsed = parseRgIgnoreFile({ text: new TextDecoder().decode(bytes), basePath: '' });
      if (!noMessages) {
        for (const diagnostic of parsed.diagnostics) {
          await context.text().error({ text: `rg: ${path}: line ${diagnostic.lineNumber}: ${diagnostic.message}\n` });
        }
      }
      rules.push(...parsed.rules);
    } catch (error: unknown) {
      if (!noMessages) {
        const detail = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `rg: ${path}: ${detail}\n` });
      }
    }
  }
  return rules;
}

async function discoverSearchFiles({
  context,
  options,
  globs,
  typeRules,
  operands,
  explicitIgnoreRules,
  consumeFile,
}: {
  context: WeshCommandContext,
  options: RgParsedArgv,
  globs: readonly RgGlobRule[],
  typeRules: readonly RgGlobRule[],
  operands: readonly string[],
  explicitIgnoreRules: readonly RgIgnoreRule[],
  consumeFile: (({ file, hadDirectoryOperand }: { file: RgSearchFile, hadDirectoryOperand: boolean }) => Promise<boolean>) | undefined,
}): Promise<{ readonly files: readonly RgSearchFile[], readonly hadError: boolean, readonly hadDirectoryOperand: boolean }> {
  const files: RgSearchFile[] = [];
  const operandFiles = operands.length === 1 ? files : [];
  const activeDirectories = new Map<string, string>();
  let hadError = false;
  let hadDirectoryOperand = false;
  let stopped = false;
  let consumingFile = false;
  const shouldStop = () => stopped || (consumeFile !== undefined && context.process.getWaitStatus()?.kind === 'signaled');

  const reportError = async ({ path, error }: { path: string, error: unknown }): Promise<void> => {
    const detail = error instanceof Error ? error.message : String(error);
    if (!options.noMessages) {
      await context.text().error({ text: `rg: ${path}: ${detail}\n` });
    }
    hadError = true;
  };

  const visit = async ({
    entry,
    displayPath,
    relativePath,
    explicit,
    inheritedIgnoreRules,
    depth,
  }: {
    entry: WeshEntryRef,
    displayPath: string,
    relativePath: string,
    explicit: boolean,
    inheritedIgnoreRules: readonly RgIgnoreRule[],
    depth: number,
  }): Promise<void> => {
    let resolvedEntry: WeshEntryRef;
    switch (entry.type) {
    case 'symlink':
      if (!options.follow && !explicit) {
        return;
      }
      try {
        resolvedEntry = await context.files.resolveEntry({
          path: entry.fullPath,
          finalSymlinkTreatment: 'follow',
        });
      } catch (error: unknown) {
        await reportError({ path: displayPath, error });
        return;
      }
      break;
    case 'file':
    case 'directory':
    case 'fifo':
    case 'chardev':
      resolvedEntry = entry;
      break;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled rg entry type: ${JSON.stringify(_ex)}`);
    }
    }

    switch (resolvedEntry.type) {
    case 'file': {
      if (!options.hidden && !explicit && basename({ path: displayPath }).startsWith('.')) {
        return;
      }
      if (!explicit && isIgnoredByRgRules({ relativePath, isDirectory: false, rules: explicitIgnoreRules })) {
        return;
      }
      if (!explicit && !options.noIgnore && isIgnoredByRgRules({ relativePath, isDirectory: false, rules: inheritedIgnoreRules })) {
        return;
      }
      if (!matchesRgGlobRules({ relativePath, rules: globs })) {
        return;
      }
      if (!matchesRgGlobRules({ relativePath, rules: typeRules })) {
        return;
      }
      const file = { fullPath: resolvedEntry.fullPath, displayPath };
      if (consumeFile === undefined) {
        operandFiles.push(file);
      } else {
        consumingFile = true;
        stopped = await consumeFile({ file, hadDirectoryOperand });
        consumingFile = false;
      }
      return;
    }
    case 'directory': {
      if (!options.hidden && !explicit && basename({ path: displayPath }).startsWith('.')) {
        return;
      }
      if (!explicit && isIgnoredByRgRules({ relativePath, isDirectory: true, rules: explicitIgnoreRules })) {
        return;
      }
      if (!explicit && !options.noIgnore && isIgnoredByRgRules({ relativePath, isDirectory: true, rules: inheritedIgnoreRules })) {
        return;
      }
      const directory = asDirectoryEntry({ entry: resolvedEntry });
      if (options.maxDepth !== undefined && depth >= options.maxDepth) {
        return;
      }
      const ancestorDisplayPath = activeDirectories.get(directory.fullPath);
      if (ancestorDisplayPath !== undefined) {
        if (!options.noMessages) {
          await context.text().error({
            text: `rg: File system loop found: ${displayPath} points to an ancestor ${ancestorDisplayPath}\n`,
          });
        }
        hadError = true;
        return;
      }
      activeDirectories.set(directory.fullPath, displayPath);
      try {
        let ignoreRules = inheritedIgnoreRules;
        if (!options.noIgnore) {
          const localRules: RgIgnoreRule[] = [];
          if (!options.noIgnoreVcs) {
            localRules.push(...await tryReadIgnoreFile({ context, directoryPath: directory.fullPath, relativeDirectoryPath: relativePath, name: '.gitignore', noMessages: options.noMessages }));
          }
          localRules.push(...await tryReadIgnoreFile({ context, directoryPath: directory.fullPath, relativeDirectoryPath: relativePath, name: '.ignore', noMessages: options.noMessages }));
          localRules.push(...await tryReadIgnoreFile({ context, directoryPath: directory.fullPath, relativeDirectoryPath: relativePath, name: '.rgignore', noMessages: options.noMessages }));
          if (localRules.length > 0) {
            ignoreRules = [...ignoreRules, ...localRules];
          }
        }
        if (shouldStop()) {
          return;
        }
        for await (const child of context.files.readDirEntry({ entry: directory })) {
          await visit({
            entry: child,
            displayPath: joinDisplayPath({ parent: displayPath, name: child.name }),
            relativePath: joinRelativePath({ parent: relativePath, name: child.name }),
            explicit: false,
            inheritedIgnoreRules: ignoreRules,
            depth: depth + 1,
          });
          if (shouldStop()) {
            break;
          }
        }
      } finally {
        activeDirectories.delete(directory.fullPath);
      }
      return;
    }
    case 'fifo':
    case 'chardev':
    case 'symlink':
      return;
    default: {
      const _ex: never = resolvedEntry;
      throw new Error(`Unhandled rg entry type: ${JSON.stringify(_ex)}`);
    }
    }
  };

  for (const operand of operands) {
    if (shouldStop()) {
      break;
    }
    const fullPath = resolvePath({ cwd: context.cwd, path: operand });
    try {
      const entry = await context.files.resolveEntry({ path: fullPath, finalSymlinkTreatment: 'no-follow' });
      switch (entry.type) {
      case 'directory':
        hadDirectoryOperand = true;
        break;
      case 'symlink':
        try {
          const followed = await context.files.resolveEntry({ path: fullPath, finalSymlinkTreatment: 'follow' });
          hadDirectoryOperand ||= followed.type === 'directory';
        } catch {
          // The normal visit path reports an explicit broken symlink consistently.
        }
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
        break;
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled rg entry type: ${JSON.stringify(_ex)}`);
      }
      }
      await visit({
        entry,
        displayPath: operand,
        relativePath: operand === '.' ? '' : operand.replace(/^\.\//, ''),
        explicit: true,
        inheritedIgnoreRules: [],
        depth: 0,
      });
      if (consumeFile === undefined) {
        switch (options.sortMode) {
        case 'default':
        case 'path':
          operandFiles.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
          break;
        case 'path-reverse':
          operandFiles.sort((left, right) => -left.displayPath.localeCompare(right.displayPath));
          break;
        case 'none':
          break;
        default: {
          const _ex: never = options.sortMode;
          throw new Error(`Unhandled rg sort mode: ${JSON.stringify(_ex)}`);
        }
        }
      }
    } catch (error: unknown) {
      // Output errors from a candidate belong to the command's normal I/O handling.
      if (consumingFile) {
        throw error;
      }
      await reportError({ path: operand, error });
    }
    if (operandFiles !== files) {
      for (const file of operandFiles) {
        files.push(file);
      }
      operandFiles.length = 0;
    }
  }

  return { files, hadError, hadDirectoryOperand };
}

function formatPrefix({
  displayPath,
  lineNumber,
  showFilename,
  showLineNumber,
  column,
  byteOffset,
  contextLine,
  nullOutput,
}: {
  displayPath: string,
  lineNumber: number,
  showFilename: boolean,
  showLineNumber: boolean,
  column: number | undefined,
  byteOffset: number | undefined,
  contextLine: boolean,
  nullOutput: boolean,
}): string {
  const separator = contextLine ? '-' : ':';
  let prefix = '';
  if (showFilename) {
    prefix += `${displayPath}${nullOutput ? '\0' : separator}`;
  }
  if (showLineNumber) {
    prefix += `${lineNumber}${separator}`;
  }
  if (column !== undefined) {
    prefix += `${column}${separator}`;
  }
  if (byteOffset !== undefined) {
    prefix += `${byteOffset}${separator}`;
  }
  return prefix;
}

function lineByteOffset({ line, start }: { line: string, start: number }): number {
  return new TextEncoder().encode(line.slice(0, start)).length;
}

function matchColumn({ line, start }: { line: string, start: number }): number {
  return lineByteOffset({ line, start }) + 1;
}

function createBufferedSearchOutput({ print }: {
  print: ReturnType<WeshCommandContext['text']>['print'],
}) {
  let pending = '';
  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const text = pending;
    pending = '';
    await print({ text });
  };
  return {
    append({ text }: { text: string }): boolean {
      pending += text;
      return pending.length >= RG_OUTPUT_BUFFER_LENGTH;
    },
    hasPending: () => pending.length !== 0,
    flush,
  };
}

interface RgSearchResult {
  readonly matched: boolean,
  readonly hadError: boolean,
  readonly wroteContextGroup: boolean,
}

async function reportFileReadError({ context, options, displayPath, error }: {
  context: WeshCommandContext,
  options: RgParsedArgv,
  displayPath: string,
  error: unknown,
}): Promise<void> {
  if (!options.noMessages) {
    const detail = error instanceof Error ? error.message : String(error);
    await context.text().error({ text: `rg: ${displayPath}: ${detail}\n` });
  }
}

async function searchInput({
  context,
  stdout,
  options,
  pattern,
  input,
  displayPath,
  showFilename,
  contextGroupAlreadyWritten,
}: {
  context: WeshCommandContext,
  stdout: ReturnType<typeof createBufferedSearchOutput>,
  options: RgParsedArgv,
  pattern: RgCompiledPattern,
  input: Blob | Uint8Array,
  displayPath: string,
  showFilename: boolean,
  contextGroupAlreadyWritten: boolean,
}): Promise<RgSearchResult> {
  const maximum = options.maxCount ?? Infinity;
  if (maximum === 0) {
    return { matched: false, hadError: false, wroteContextGroup: false };
  }

  const normalOutput = !options.quiet && options.outputMode === 'normal';
  const countOutput = !options.quiet && (options.outputMode === 'count-lines' || options.outputMode === 'count-matches');
  const filesWithoutMatch = options.outputMode === 'files-without-match';
  const countRanges = !options.invertMatch && (options.outputMode === 'count-matches' || options.onlyMatching);
  const onlyMatching = options.onlyMatching && !options.invertMatch;
  const showContext = !onlyMatching && (options.beforeContext > 0 || options.afterContext > 0);
  const wasSignaled = () => context.process.getWaitStatus()?.kind === 'signaled';
  const readLines = createRgLineReader({ trackByteOffsets: normalOutput && options.byteOffset });
  const length = input instanceof Uint8Array ? input.length : input.size;

  let nulOffset: number | undefined;
  let selected = 0;
  let count = 0;
  let flushed = false;
  let wroteContextGroup = false;
  let lastOutputLine = 0;
  let afterThrough = 0;
  let beforeLines: (RgInputLine | undefined)[] = [];
  let beforeStart = 0;

  function* formatOutput({ record, match }: { record: RgInputLine, match: RgLineMatch | undefined }): IterableIterator<string> {
    if (showContext && (lastOutputLine === 0 || record.number > lastOutputLine + 1)) {
      if (contextGroupAlreadyWritten || wroteContextGroup) {
        yield '--\n';
      }
      wroteContextGroup = true;
    }
    lastOutputLine = record.number;
    const first = match?.ranges[0];
    const prefix = formatPrefix({
      displayPath,
      lineNumber: record.number,
      showFilename,
      showLineNumber: options.lineNumber ?? options.column,
      column: options.column && first !== undefined ? matchColumn({ line: record.text, start: first.start }) : undefined,
      byteOffset: options.byteOffset ? record.byteOffset : undefined,
      contextLine: match === undefined,
      nullOutput: options.nullOutput,
    });
    yield `${prefix}${record.text}\n`;
  }

  function* formatMatch({ record, match }: { record: RgInputLine, match: RgLineMatch }): IterableIterator<string> {
    if (onlyMatching) {
      for (const { start, end } of match.ranges) {
        const offset = options.byteOffset || options.column ? lineByteOffset({ line: record.text, start }) : 0;
        const prefix = formatPrefix({
          displayPath,
          lineNumber: record.number,
          showFilename,
          showLineNumber: options.lineNumber ?? options.column,
          column: options.column ? offset + 1 : undefined,
          byteOffset: options.byteOffset ? record.byteOffset + offset : undefined,
          contextLine: false,
          nullOutput: options.nullOutput,
        });
        yield `${prefix}${record.text.slice(start, end)}\n`;
      }
      return;
    }

    for (const before of beforeLines) {
      if (before !== undefined) {
        yield* formatOutput({ record: before, match: undefined });
      }
    }
    beforeLines.length = 0;
    beforeStart = 0;
    yield* formatOutput({ record, match });
  }

  search: for (let offset = 0; offset < length;) {
    // Make a sparse first match visible before waiting for more input.
    if (!flushed && stdout.hasPending()) {
      await stdout.flush();
      flushed = true;
    }
    if (wasSignaled()) {
      break;
    }
    const firstChunk = offset === 0;
    const end = Math.min(offset + (firstChunk ? RG_BINARY_SCAN_LIMIT : RG_INPUT_CHUNK_LENGTH), length);
    let bytes: Uint8Array;
    try {
      if (input instanceof Uint8Array) {
        bytes = input.subarray(offset, end);
      } else {
        const chunk = firstChunk && end === length ? input : input.slice(offset, end);
        bytes = new Uint8Array(await chunk.arrayBuffer());
      }
      if (bytes.length !== end - offset) {
        throw new Error('Unexpected end of file');
      }
    } catch (error: unknown) {
      if (wasSignaled()) {
        break;
      }
      await stdout.flush();
      if (wasSignaled()) {
        break;
      }
      await reportFileReadError({ context, options, displayPath, error });
      return { matched: selected !== 0, hadError: true, wroteContextGroup };
    }
    if (wasSignaled()) {
      break;
    }
    if (firstChunk && normalOutput && !options.text) {
      nulOffset = findNulOffset({ bytes });
    }

    for (const record of readLines({ bytes, endOfInput: end === length })) {
      const candidate = selected < maximum ? pattern.matchLine({ line: record.text }) : undefined;
      const match = candidate?.selected ? candidate : undefined;
      if (match !== undefined) {
        selected += 1;
        if (countOutput) {
          count += countRanges ? match.ranges.length : 1;
        } else if (!normalOutput || nulOffset !== undefined) {
          break search;
        } else if (showContext) {
          afterThrough = record.number + options.afterContext;
        }
      }

      if (normalOutput && nulOffset === undefined) {
        let output: Iterable<string> | undefined;
        if (match !== undefined) {
          output = formatMatch({ record, match });
        } else if (record.number <= afterThrough) {
          output = formatOutput({ record, match: undefined });
        } else if (showContext && options.beforeContext > 0) {
          beforeLines.push(record);
          if (beforeLines.length - beforeStart > options.beforeContext) {
            beforeLines[beforeStart++] = undefined;
          }
          if (beforeStart >= 256 && beforeStart * 2 >= beforeLines.length) {
            beforeLines = beforeLines.slice(beforeStart);
            beforeStart = 0;
          }
        }
        if (output !== undefined) {
          for (const text of output) {
            if (stdout.append({ text })) {
              await stdout.flush();
              flushed = true;
              if (wasSignaled()) {
                break search;
              }
            }
          }
        }
      }
      if (selected >= maximum && record.number >= afterThrough) {
        break search;
      }
    }
    offset = end;
  }

  const matched = selected !== 0;
  if (wasSignaled() || options.quiet) {
    return { matched, hadError: false, wroteContextGroup };
  }
  const { print } = context.text();
  switch (options.outputMode) {
  case 'normal':
    if (nulOffset !== undefined && matched) {
      const prefix = showFilename ? `${displayPath}: ` : '';
      await print({ text: `${prefix}binary file matches (found "\\0" byte around offset ${nulOffset})\n` });
    } else {
      await stdout.flush();
    }
    return { matched, hadError: false, wroteContextGroup };
  case 'files-with-matches':
  case 'files-without-match': {
    const selectedFile = filesWithoutMatch ? !matched : matched;
    if (selectedFile) {
      await print({ text: `${displayPath}${options.nullOutput ? '\0' : '\n'}` });
    }
    return { matched: selectedFile, hadError: false, wroteContextGroup: false };
  }
  case 'count-lines':
  case 'count-matches':
    if (count !== 0) {
      const prefix = showFilename ? `${displayPath}${options.nullOutput ? '\0' : ':'}` : '';
      await print({ text: `${prefix}${count}\n` });
    }
    return { matched: count !== 0, hadError: false, wroteContextGroup: false };
  default: {
    const _ex: never = options.outputMode;
    throw new Error(`Unhandled rg output mode: ${_ex}`);
  }
  }
}

async function searchOneFile({
  context,
  stdout,
  options,
  pattern,
  file,
  showFilename,
  contextGroupAlreadyWritten,
}: {
  context: WeshCommandContext,
  stdout: ReturnType<typeof createBufferedSearchOutput>,
  options: RgParsedArgv,
  pattern: RgCompiledPattern,
  file: RgSearchFile,
  showFilename: boolean,
  contextGroupAlreadyWritten: boolean,
}): Promise<RgSearchResult> {
  let input: Blob | Uint8Array;
  try {
    const { open, stat, tryReadBlobEfficiently } = context.files;
    const result = await tryReadBlobEfficiently({ path: file.fullPath });
    switch (result.kind) {
    case 'blob':
      input = result.blob;
      break;
    case 'fallback_required':
      input = await readAllFileBytes({ files: { open, stat }, path: file.fullPath });
      break;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled blob result: ${_ex}`);
    }
    }
  } catch (error: unknown) {
    const wasSignaled = context.process.getWaitStatus()?.kind === 'signaled';
    if (wasSignaled) {
      return { matched: false, hadError: false, wroteContextGroup: false };
    }
    await reportFileReadError({ context, options, displayPath: file.displayPath, error });
    return { matched: false, hadError: true, wroteContextGroup: false };
  }

  return searchInput({
    context,
    stdout,
    options,
    pattern,
    input,
    displayPath: file.displayPath,
    showFilename,
    contextGroupAlreadyWritten,
  });
}

async function searchStdin({
  context,
  stdout,
  options,
  pattern,
  showFilename,
  contextGroupAlreadyWritten,
}: {
  context: WeshCommandContext,
  stdout: ReturnType<typeof createBufferedSearchOutput>,
  options: RgParsedArgv,
  pattern: RgCompiledPattern,
  showFilename: boolean,
  contextGroupAlreadyWritten: boolean,
}): Promise<RgSearchResult> {
  const input = await readAllHandleBytes({ handle: context.stdin });
  return searchInput({
    context,
    stdout,
    options,
    pattern,
    input,
    displayPath: '<stdin>',
    showFilename,
    contextGroupAlreadyWritten,
  });
}

export const rgCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const options = parseRgArgv({ args: context.args });
    if (options.diagnostic !== undefined) {
      await writeCommandUsageError({ context, command: 'rg', message: `rg: ${options.diagnostic}`, usageSummary: getRgUsageSummary() });
      return { exitCode: 2 };
    }
    if (options.help) {
      await writeCommandHelp({ context, command: 'rg', optionLines: getRgOptionHelp() });
      return { exitCode: 0 };
    }
    if (options.version) {
      await context.text().print({ text: RG_VERSION_TEXT });
      return { exitCode: 0 };
    }
    if (options.typeList) {
      await context.text().print({ text: getRgTypeListText() });
      return { exitCode: 0 };
    }
    if (!options.files && options.pattern === undefined) {
      await writeCommandUsageError({ context, command: 'rg', message: 'rg: a pattern is required', usageSummary: getRgUsageSummary() });
      return { exitCode: 2 };
    }

    let compiledPattern: RgCompiledPattern | undefined;
    if (!options.files) {
      try {
        compiledPattern = compilePattern({ options });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `rg: ${message}\n` });
        return { exitCode: 2 };
      }
    }

    let globRules: readonly RgGlobRule[];
    let typeRules: readonly RgGlobRule[];
    try {
      globRules = options.globs.map((glob) => compileRgGlobRule({ rawPattern: glob.pattern, caseInsensitive: glob.caseInsensitive }));
      typeRules = compileRgTypeRules({ filters: options.typeFilters });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `rg: ${message}\n` });
      return { exitCode: 2 };
    }
    const explicitIgnoreRules = await readExplicitIgnoreRules({ context, paths: options.ignoreFiles, noMessages: options.noMessages });
    const operands = options.paths.length > 0 ? options.paths : ['.'];
    const stdinOperandCount = operands.filter((operand) => operand === '-').length;
    const filesystemOperands = operands.filter((operand) => operand !== '-');
    // Shell text output preserves raw bytes represented in file names.
    const { print } = context.text();
    const wasSignaled = () => context.process.getWaitStatus()?.kind === 'signaled';
    const stdout = createBufferedSearchOutput({ print });
    const unsorted = options.sortMode === 'none';
    // Quiet search over one operand has no output order to preserve. For
    // sorted multiple operands, check the explicit paths even after a match.
    const quietSingleOperand = options.quiet && !options.files && options.sortMode === 'default'
      && operands.length === 1 && stdinOperandCount === 0;
    let anyMatch = false;
    let hadError = false;
    let contextGroupAlreadyWritten = false;
    const recordSearchResult = ({ result }: { result: RgSearchResult }): boolean => {
      anyMatch ||= result.matched;
      hadError ||= result.hadError;
      contextGroupAlreadyWritten ||= result.wroteContextGroup;
      return wasSignaled() || (options.quiet && result.matched);
    };
    const listFile = async ({ displayPath }: { displayPath: string }): Promise<boolean> => {
      anyMatch = true;
      if (unsorted && options.quiet) {
        return true;
      }
      await print({ text: `${displayPath}${options.nullOutput ? '\0' : '\n'}` });
      return wasSignaled();
    };
    const consumeFile = async ({ file, hadDirectoryOperand }: {
      file: RgSearchFile,
      hadDirectoryOperand: boolean,
    }): Promise<boolean> => {
      if (compiledPattern === undefined) {
        const displayPath = options.paths.length === 0 ? file.displayPath.replace(/^\.\//, '') : file.displayPath;
        return listFile({ displayPath });
      }
      const result = await searchOneFile({
        context,
        stdout,
        options,
        pattern: compiledPattern,
        file,
        showFilename: options.withFilename ?? (operands.length > 1 || hadDirectoryOperand),
        contextGroupAlreadyWritten,
      });
      return recordSearchResult({ result });
    };
    const consumeStdin = async (): Promise<boolean> => {
      for (let index = 0; index < stdinOperandCount; index += 1) {
        if (compiledPattern === undefined) {
          if (await listFile({ displayPath: '<stdin>' })) {
            return true;
          }
        } else {
          const result = await searchStdin({
            context,
            stdout,
            options,
            pattern: compiledPattern,
            showFilename: options.withFilename ?? (operands.length > 1),
            contextGroupAlreadyWritten,
          });
          if (recordSearchResult({ result })) {
            return true;
          }
        }
      }
      return false;
    };
    if (unsorted && await consumeStdin()) {
      return { exitCode: 0 };
    }
    const collected = await discoverSearchFiles({
      context,
      options,
      globs: globRules,
      typeRules,
      operands: filesystemOperands,
      explicitIgnoreRules,
      consumeFile: unsorted || quietSingleOperand ? consumeFile : undefined,
    });
    if (!unsorted) {
      if (await consumeStdin()) {
        return { exitCode: 0 };
      }
      for (const file of collected.files) {
        if (await consumeFile({ file, hadDirectoryOperand: collected.hadDirectoryOperand })) {
          return { exitCode: 0 };
        }
      }
    }
    if (options.quiet && anyMatch && (unsorted || !options.files)) {
      return { exitCode: 0 };
    }
    if (hadError || collected.hadError) {
      return { exitCode: 2 };
    }
    return { exitCode: anyMatch ? 0 : 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
