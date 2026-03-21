import type { FileTypeResult } from 'file-type';
import type { WeshFileType } from '@/services/wesh/types';

export interface FileCommandTargetInfo {
  displayPath: string;
  resolvedPath: string;
  fileType: WeshFileType;
  size: number;
  symlinkTarget: string | undefined;
}

export type FileCommandClassification =
  | { kind: 'directory' }
  | { kind: 'fifo' }
  | { kind: 'symlink'; target: string }
  | { kind: 'empty' }
  | { kind: 'binary'; detected: FileTypeResult }
  | { kind: 'json' }
  | { kind: 'xml' }
  | { kind: 'svg' }
  | { kind: 'html' }
  | { kind: 'shell-script' }
  | { kind: 'ascii-text' }
  | { kind: 'utf8-text' }
  | { kind: 'utf16-text' }
  | { kind: 'data' };
