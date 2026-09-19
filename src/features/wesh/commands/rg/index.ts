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

const RG_BINARY_SCAN_LIMIT = 64 * 1024;
const RG_VERSION_TEXT = 'ripgrep 14.1.1 (Wesh compatible subset)\n';

interface RgSearchFile {
  readonly fullPath: string,
  readonly displayPath: string,
  readonly relativePath: string,
}

interface RgLineMatch {
  readonly selected: boolean,
  readonly ranges: readonly { readonly start: number, readonly end: number }[],
}

interface RgCompiledPattern {
  readonly matchLine: ({ line }: { line: string }) => RgLineMatch,
}

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) return path;
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function joinDisplayPath({ parent, name }: { parent: string, name: string }): string {
  if (parent === '.') return `./${name}`;
  if (parent === '/') return `/${name}`;
  return `${parent.replace(/\/$/, '')}/${name}`;
}

function joinRelativePath({ parent, name }: { parent: string, name: string }): string {
  if (parent.length === 0) return name;
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
  if (!options.wordRegexp) return ranges;
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
            if (index === -1) break;
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
        if (match === null) break;
        ranges.push({ start: match.index, end: match.index + match[0].length });
        if (match[0].length === 0) {
          regex.lastIndex += 1;
          if (regex.lastIndex > line.length) break;
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
    if (bytes[index] === 0) return index;
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

async function collectSearchFiles({
  context,
  options,
  globs,
  typeRules,
  operands,
  explicitIgnoreRules,
}: {
  context: WeshCommandContext,
  options: RgParsedArgv,
  globs: readonly RgGlobRule[],
  typeRules: readonly RgGlobRule[],
  operands: readonly string[],
  explicitIgnoreRules: readonly RgIgnoreRule[],
}): Promise<{ readonly files: readonly RgSearchFile[], readonly hadError: boolean, readonly hadDirectoryOperand: boolean }> {
  const files: RgSearchFile[] = [];
  const activeDirectories = new Map<string, string>();
  let hadError = false;
  let hadDirectoryOperand = false;

  const reportError = async ({ path, error }: { path: string, error: unknown }): Promise<void> => {
    const detail = error instanceof Error ? error.message : String(error);
    if (!options.noMessages) await context.text().error({ text: `rg: ${path}: ${detail}\n` });
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
      if (!options.follow && !explicit) return;
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
    case 'file':
      if (!options.hidden && !explicit && basename({ path: displayPath }).startsWith('.')) return;
      if (!explicit && isIgnoredByRgRules({ relativePath, isDirectory: false, rules: explicitIgnoreRules })) return;
      if (!explicit && !options.noIgnore && isIgnoredByRgRules({ relativePath, isDirectory: false, rules: inheritedIgnoreRules })) return;
      if (!matchesRgGlobRules({ relativePath, rules: globs })) return;
      if (!matchesRgGlobRules({ relativePath, rules: typeRules })) return;
      files.push({ fullPath: resolvedEntry.fullPath, displayPath, relativePath });
      return;
    case 'directory': {
      if (!options.hidden && !explicit && basename({ path: displayPath }).startsWith('.')) return;
      if (!explicit && isIgnoredByRgRules({ relativePath, isDirectory: true, rules: explicitIgnoreRules })) return;
      if (!explicit && !options.noIgnore && isIgnoredByRgRules({ relativePath, isDirectory: true, rules: inheritedIgnoreRules })) return;
      const directory = asDirectoryEntry({ entry: resolvedEntry });
      if (options.maxDepth !== undefined && depth >= options.maxDepth) return;
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
          if (localRules.length > 0) ignoreRules = [...ignoreRules, ...localRules];
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
    const operandFileStart = files.length;
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
      const operandFiles = files.splice(operandFileStart);
      const sortDirection = (() => {
        switch (options.sortMode) {
        case 'default':
        case 'path':
          return 1;
        case 'path-reverse':
          return -1;
        default: {
          const _ex: never = options.sortMode;
          throw new Error(`Unhandled rg sort mode: ${JSON.stringify(_ex)}`);
        }
        }
      })();
      operandFiles.sort((left, right) => sortDirection * left.displayPath.localeCompare(right.displayPath));
      files.push(...operandFiles);
    } catch (error: unknown) {
      await reportError({ path: operand, error });
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
  if (showFilename) prefix += `${displayPath}${nullOutput ? '\0' : separator}`;
  if (showLineNumber) prefix += `${lineNumber}${separator}`;
  if (column !== undefined) prefix += `${column}${separator}`;
  if (byteOffset !== undefined) prefix += `${byteOffset}${separator}`;
  return prefix;
}

function lineByteOffset({ line, start }: { line: string, start: number }): number {
  return new TextEncoder().encode(line.slice(0, start)).length;
}

function matchColumn({ line, start }: { line: string, start: number }): number {
  return lineByteOffset({ line, start }) + 1;
}

function lineStartByteOffsets({ bytes }: { bytes: Uint8Array }): readonly number[] {
  const offsets = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10 && index + 1 < bytes.length) offsets.push(index + 1);
  }
  return offsets;
}

async function searchBytes({
  context,
  options,
  pattern,
  bytes,
  displayPath,
  showFilename,
  contextGroupAlreadyWritten,
}: {
  context: WeshCommandContext,
  options: RgParsedArgv,
  pattern: RgCompiledPattern,
  bytes: Uint8Array,
  displayPath: string,
  showFilename: boolean,
  contextGroupAlreadyWritten: boolean,
}): Promise<{ readonly matched: boolean, readonly hadError: boolean, readonly wroteContextGroup: boolean }> {
  const nulOffset = findNulOffset({ bytes });
  const byteOffsets = lineStartByteOffsets({ bytes });
  const lines = new TextDecoder().decode(bytes).split('\n');
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();

  if (options.maxCount === 0) return { matched: false, hadError: false, wroteContextGroup: false };

  let selectedLineCount = 0;
  let matchCount = 0;
  const selectedLines = new Map<number, RgLineMatch>();
  for (let index = 0; index < lines.length; index += 1) {
    const result = pattern.matchLine({ line: lines[index] ?? '' });
    if (!result.selected) continue;
    selectedLineCount += 1;
    matchCount += options.invertMatch ? 1 : result.ranges.length;
    selectedLines.set(index, result);
    if (options.maxCount !== undefined && selectedLineCount >= options.maxCount) break;
  }

  if (options.quiet) {
    return { matched: selectedLineCount > 0, hadError: false, wroteContextGroup: false };
  }
  switch (options.outputMode) {
  case 'files-without-match':
    if (selectedLineCount > 0) return { matched: false, hadError: false, wroteContextGroup: false };
    await context.text().print({ text: `${displayPath}${options.nullOutput ? '\0' : '\n'}` });
    return { matched: true, hadError: false, wroteContextGroup: false };
  case 'files-with-matches':
    if (selectedLineCount === 0) return { matched: false, hadError: false, wroteContextGroup: false };
    await context.text().print({ text: `${displayPath}${options.nullOutput ? '\0' : '\n'}` });
    return { matched: true, hadError: false, wroteContextGroup: false };
  case 'count-lines':
  case 'count-matches': {
    if (selectedLineCount === 0) return { matched: false, hadError: false, wroteContextGroup: false };
    const value = options.outputMode === 'count-matches' || (options.onlyMatching && !options.invertMatch)
      ? matchCount
      : selectedLineCount;
    const prefix = showFilename ? `${displayPath}${options.nullOutput ? '\0' : ':'}` : '';
    await context.text().print({ text: `${prefix}${value}\n` });
    return { matched: true, hadError: false, wroteContextGroup: false };
  }
  case 'normal':
    if (selectedLineCount === 0) return { matched: false, hadError: false, wroteContextGroup: false };
    break;
  default: {
    const _ex: never = options.outputMode;
    throw new Error(`Unhandled rg output mode: ${JSON.stringify(_ex)}`);
  }
  }
  if (nulOffset !== undefined && !options.text) {
    const prefix = showFilename ? `${displayPath}: ` : '';
    await context.text().print({ text: `${prefix}binary file matches (found "\\0" byte around offset ${nulOffset})\n` });
    return { matched: true, hadError: false, wroteContextGroup: false };
  }

  if (options.onlyMatching && !options.invertMatch) {
    for (const [index, result] of selectedLines) {
      const line = lines[index] ?? '';
      for (const range of result.ranges) {
        const prefix = formatPrefix({
          displayPath,
          lineNumber: index + 1,
          showFilename,
          showLineNumber: options.lineNumber ?? options.column,
          column: options.column ? matchColumn({ line, start: range.start }) : undefined,
          byteOffset: options.byteOffset
            ? (byteOffsets[index] ?? 0) + lineByteOffset({ line, start: range.start })
            : undefined,
          contextLine: false,
          nullOutput: options.nullOutput,
        });
        await context.text().print({ text: `${prefix}${line.slice(range.start, range.end)}\n` });
      }
    }
    return { matched: true, hadError: false, wroteContextGroup: false };
  }

  const outputIndexes = new Set<number>();
  for (const index of selectedLines.keys()) {
    const start = Math.max(0, index - options.beforeContext);
    const end = Math.min(lines.length - 1, index + options.afterContext);
    for (let outputIndex = start; outputIndex <= end; outputIndex += 1) outputIndexes.add(outputIndex);
  }
  const sortedOutputIndexes = [...outputIndexes].sort((left, right) => left - right);
  const hasContext = options.beforeContext > 0 || options.afterContext > 0;
  let previousIndex: number | undefined;
  let wroteContextGroup = false;
  for (const index of sortedOutputIndexes) {
    const startsContextGroup = hasContext && (previousIndex === undefined || index > previousIndex + 1);
    if (startsContextGroup) {
      if (contextGroupAlreadyWritten || wroteContextGroup) await context.text().print({ text: '--\n' });
      wroteContextGroup = true;
    }
    const selectedMatch = selectedLines.get(index);
    const selected = selectedMatch !== undefined;
    const line = lines[index] ?? '';
    const firstRange = selectedMatch?.ranges[0];
    const prefix = formatPrefix({
      displayPath,
      lineNumber: index + 1,
      showFilename,
      showLineNumber: options.lineNumber ?? options.column,
      column: selected && options.column && firstRange !== undefined
        ? matchColumn({ line, start: firstRange.start })
        : undefined,
      byteOffset: options.byteOffset ? (byteOffsets[index] ?? 0) : undefined,
      contextLine: !selected,
      nullOutput: options.nullOutput,
    });
    await context.text().print({ text: `${prefix}${line}\n` });
    previousIndex = index;
  }
  return { matched: true, hadError: false, wroteContextGroup };
}

async function searchOneFile({
  context,
  options,
  pattern,
  file,
  showFilename,
  contextGroupAlreadyWritten,
}: {
  context: WeshCommandContext,
  options: RgParsedArgv,
  pattern: RgCompiledPattern,
  file: RgSearchFile,
  showFilename: boolean,
  contextGroupAlreadyWritten: boolean,
}): Promise<{ readonly matched: boolean, readonly hadError: boolean, readonly wroteContextGroup: boolean }> {
  let bytes: Uint8Array;
  try {
    bytes = await readAllFileBytes({ files: context.files, path: file.fullPath });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!options.noMessages) await context.text().error({ text: `rg: ${file.displayPath}: ${detail}\n` });
    return { matched: false, hadError: true, wroteContextGroup: false };
  }

  return searchBytes({
    context,
    options,
    pattern,
    bytes,
    displayPath: file.displayPath,
    showFilename,
    contextGroupAlreadyWritten,
  });
}

async function searchStdin({
  context,
  options,
  pattern,
  showFilename,
  contextGroupAlreadyWritten,
}: {
  context: WeshCommandContext,
  options: RgParsedArgv,
  pattern: RgCompiledPattern,
  showFilename: boolean,
  contextGroupAlreadyWritten: boolean,
}): Promise<{ readonly matched: boolean, readonly hadError: boolean, readonly wroteContextGroup: boolean }> {
  const bytes = await readAllHandleBytes({ handle: context.stdin });
  return searchBytes({
    context,
    options,
    pattern,
    bytes,
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
    const collected = await collectSearchFiles({
      context,
      options,
      globs: globRules,
      typeRules,
      operands: filesystemOperands,
      explicitIgnoreRules,
    });

    if (options.files) {
      for (let index = 0; index < stdinOperandCount; index += 1) {
        await context.text().print({ text: `<stdin>${options.nullOutput ? '\0' : '\n'}` });
      }
      for (const file of collected.files) {
        const display = options.paths.length === 0 ? file.displayPath.replace(/^\.\//, '') : file.displayPath;
        await context.text().print({ text: `${display}${options.nullOutput ? '\0' : '\n'}` });
      }
      if (collected.hadError) return { exitCode: 2 };
      return { exitCode: stdinOperandCount + collected.files.length > 0 ? 0 : 1 };
    }

    if (compiledPattern === undefined) throw new Error('rg pattern compilation invariant violated');
    const showFilename = options.withFilename ?? (operands.length > 1 || collected.hadDirectoryOperand);
    let anyMatch = false;
    let hadError = collected.hadError;
    let contextGroupAlreadyWritten = false;
    for (let index = 0; index < stdinOperandCount; index += 1) {
      const result = await searchStdin({
        context,
        options,
        pattern: compiledPattern,
        showFilename,
        contextGroupAlreadyWritten,
      });
      hadError ||= result.hadError;
      contextGroupAlreadyWritten ||= result.wroteContextGroup;
      if (result.matched) {
        anyMatch = true;
        if (options.quiet) return { exitCode: 0 };
      }
    }
    for (const file of collected.files) {
      const result = await searchOneFile({
        context,
        options,
        pattern: compiledPattern,
        file,
        showFilename,
        contextGroupAlreadyWritten,
      });
      hadError ||= result.hadError;
      contextGroupAlreadyWritten ||= result.wroteContextGroup;
      if (result.matched) {
        anyMatch = true;
        if (options.quiet) return { exitCode: 0 };
      }
    }
    if (hadError) return { exitCode: 2 };
    return { exitCode: anyMatch ? 0 : 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
