export type PatchFormat = 'unified' | 'context' | 'normal' | 'ed';

export type PatchDirection = 'forward' | 'reverse';

export type PatchOperation = 'modify' | 'create' | 'delete' | 'copy' | 'rename';

export type PatchFileKind = 'regular' | 'symlink';

export type PatchLineKind = 'context' | 'remove' | 'add';

export type PatchWhitespaceMode = 'exact' | 'ignore-changes';

export interface PatchLine {
  kind: PatchLineKind,
  content: Uint8Array,
  terminator: 'lf' | 'none',
}

export interface PatchRange {
  start: number,
  count: number,
}

export interface TextHunk {
  oldRange: PatchRange,
  newRange: PatchRange,
  heading: string | undefined,
  lines: PatchLine[],
  sourceLineNumber: number,
}

export interface EdCommand {
  start: number,
  end: number,
  operation: 'append' | 'change' | 'delete',
  lines: Array<{
    content: Uint8Array,
    terminator: 'lf' | 'none',
  }>,
  sourceLineNumber: number,
}

export interface PatchSectionHeader {
  oldPath: string | undefined,
  newPath: string | undefined,
  indexPath: string | undefined,
  operation: PatchOperation,
  oldKind: PatchFileKind,
  newKind: PatchFileKind,
  oldMode: number | undefined,
  newMode: number | undefined,
  renameFrom: string | undefined,
  renameTo: string | undefined,
  copyFrom: string | undefined,
  copyTo: string | undefined,
  gitBinary: boolean,
}

export interface TextPatchSection {
  kind: 'text',
  format: Exclude<PatchFormat, 'ed'>,
  header: PatchSectionHeader,
  hunks: TextHunk[],
  sourceLineNumber: number,
}

export interface EdPatchSection {
  kind: 'ed',
  format: 'ed',
  header: PatchSectionHeader,
  commands: EdCommand[],
  sourceLineNumber: number,
}

export type PatchSection = TextPatchSection | EdPatchSection;

export interface ParsedPatchDocument {
  sections: PatchSection[],
  strippedCarriageReturns: boolean,
}

export type BackupStyle = 'simple' | 'numbered' | 'existing';

export type RejectFormat = 'unified' | 'context';

export interface PatchOptions {
  stripCount: number | undefined,
  fuzz: number,
  whitespaceMode: PatchWhitespaceMode,
  forcedFormat: PatchFormat | undefined,
  directionMode: 'auto' | 'forward-only' | 'reverse',
  reverseDecisionMode: 'safe-skip' | 'assume-reverse' | 'force-forward',
  inputPath: string | undefined,
  outputPath: string | undefined,
  rejectPath: string | undefined,
  directory: string | undefined,
  backupMode: 'if-mismatch' | 'always' | 'never',
  backupPrefix: string | undefined,
  backupBasenamePrefix: string | undefined,
  backupSuffix: string,
  backupStyle: BackupStyle,
  removeEmptyFiles: boolean,
  ifdefName: string | undefined,
  quietMode: 'normal' | 'quiet' | 'verbose',
  dryRun: boolean,
  atomic: boolean,
  safePaths: boolean,
  posix: boolean,
  binary: boolean,
  rejectFormat: RejectFormat | undefined,
  getMode: number | undefined,
  unsupportedOption: string | undefined,
}

export interface ResolvedPatchOperands {
  originalPath: string | undefined,
  patchPath: string | undefined,
}

export interface ApplyHunkSuccess {
  kind: 'success',
  pieces: OutputPiece[],
  matchedAt: number,
  offset: number,
  fuzz: number,
}

export interface ApplyHunkFailure {
  kind: 'failure',
}

export type ApplyHunkResult = ApplyHunkSuccess | ApplyHunkFailure;

export interface FileLine {
  content: Uint8Array,
  terminator: 'lf' | 'none',
}


export interface PatchLineSource {
  readonly byteLength: number,
  readonly lineCount: number,
  boundaryOffset({ lineIndex }: { lineIndex: number }): number,
  lineMatches({
    lineIndex,
    patchLine,
    whitespaceMode,
  }: {
    lineIndex: number,
    patchLine: PatchLine,
    whitespaceMode: PatchWhitespaceMode,
  }): Promise<boolean>,
  forEachChunk({
    start,
    end,
    consume,
  }: {
    start: number,
    end: number,
    consume({ chunk }: { chunk: Uint8Array }): Promise<void>,
  }): Promise<void>,
}

export type OutputPiece =
  | {
      kind: 'source',
      startLine: number,
      endLine: number,
    }
  | {
      kind: 'bytes',
      bytes: Uint8Array,
      lineCount: number,
    };

export type PatchContent =
  | {
      kind: 'bytes',
      bytes: Uint8Array,
    }
  | {
      kind: 'line-plan',
      source: PatchLineSource,
      pieces: OutputPiece[],
    }
  | {
      kind: 'file',
      path: string,
    }
  | {
      kind: 'sequence',
      contents: PatchContent[],
    };

export interface ApplySectionResult {
  pieces: OutputPiece[],
  rejectedHunks: TextHunk[],
  usedOffset: boolean,
  usedFuzz: boolean,
  diagnostics: string[],
  direction: PatchDirection,
}

export interface PatchTarget {
  displayPath: string,
  sourcePath: string | undefined,
  destinationPath: string,
  operation: PatchOperation,
}

export interface PatchExecutionSummary {
  exitCode: 0 | 1 | 2,
  outputChunks: Uint8Array[],
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
