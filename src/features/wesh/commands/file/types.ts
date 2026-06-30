import type { FileTypeResult } from 'file-type';
import type { WeshFileType } from '@/features/wesh/types';

export interface FileCommandTargetInfo {
  displayPath: string,
  resolvedPath: string,
  fileType: WeshFileType,
  size: number,
  symlinkTarget: string | undefined,
}

export type FileCommandClassification =
  | { kind: 'directory' }
  | { kind: 'fifo' }
  | { kind: 'symlink', target: string }
  | { kind: 'empty' }
  | { kind: 'binary', detected: FileTypeResult }
  | { kind: 'json' }
  | { kind: 'xml' }
  | { kind: 'svg' }
  | { kind: 'html' }
  | { kind: 'shell_script' }
  | { kind: 'ascii_text' }
  | { kind: 'utf8_text' }
  | { kind: 'utf16_text' }
  | { kind: 'data' };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
