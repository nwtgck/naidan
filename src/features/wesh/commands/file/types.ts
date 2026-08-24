import type { FileTypeResult } from 'file-type';
import type { WeshFileType } from '@/features/wesh/types';

export interface FileCommandTargetInfo {
  displayPath: string,
  resolvedPath: string,
  fileType: WeshFileType,
  size: number,
  symlinkTarget: string | undefined,
  symlinkBroken: boolean,
}

export type FileCommandTextEncoding =
  | 'us-ascii'
  | 'iso-8859-1'
  | 'unknown-8bit'
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be';

export type FileCommandLineTerminator = 'crlf' | 'cr' | 'lf' | 'nel';

export interface FileCommandTextDetails {
  encoding: FileCommandTextEncoding,
  hasByteOrderMark: boolean,
  veryLongLineLength: number | undefined,
  lineTerminators: readonly FileCommandLineTerminator[],
  hasEscapeSequences: boolean,
  hasOverstriking: boolean,
}

export type FileCommandScriptLanguage =
  | 'posix_shell'
  | 'bash'
  | 'python'
  | 'node';

export type FileCommandClassification =
  | { kind: 'directory' }
  | { kind: 'fifo' }
  | { kind: 'symlink', target: string, broken: boolean }
  | { kind: 'empty', source: 'file' | 'stdin' }
  | { kind: 'binary', detected: FileTypeResult }
  | { kind: 'json', text: FileCommandTextDetails }
  | { kind: 'xml', version: string | undefined, text: FileCommandTextDetails }
  | { kind: 'svg', text: FileCommandTextDetails }
  | { kind: 'html', text: FileCommandTextDetails }
  | {
      kind: 'script',
      language: FileCommandScriptLanguage,
      text: FileCommandTextDetails,
    }
  | { kind: 'ascii_text', text: FileCommandTextDetails }
  | { kind: 'extended_ascii_text', text: FileCommandTextDetails }
  | { kind: 'utf8_text', text: FileCommandTextDetails }
  | { kind: 'utf16_text', text: FileCommandTextDetails }
  | { kind: 'data' };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
