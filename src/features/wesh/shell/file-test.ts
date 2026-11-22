import { toAbsolutePath } from '@/features/wesh/path';
import type { WeshEntryRef, WeshFinalSymlinkTreatment, WeshIVirtualFileSystem, WeshStat } from '@/features/wesh/types';

export type UnaryFileTestOperator =
  | '-b'
  | '-c'
  | '-d'
  | '-e'
  | '-f'
  | '-h'
  | '-L'
  | '-p'
  | '-r'
  | '-s'
  | '-S'
  | '-t'
  | '-w'
  | '-x';

export type BinaryFileTestOperator = '-ef' | '-nt' | '-ot';

type FileTestFiles = Pick<WeshIVirtualFileSystem, 'stat' | 'resolveEntry' | 'compareEntryIdentity'>;

async function resolveTestEntry({ files, cwd, operand, finalSymlinkTreatment, pinBacking }: {
  files: Pick<FileTestFiles, 'resolveEntry'>,
  cwd: string,
  operand: string,
  finalSymlinkTreatment: WeshFinalSymlinkTreatment,
  pinBacking?: true,
}): Promise<WeshEntryRef | undefined> {
  if (operand === '') {
    return undefined;
  }
  try {
    return await files.resolveEntry({ path: toAbsolutePath({ cwd, path: operand }), finalSymlinkTreatment, pinBacking });
  } catch {
    return undefined;
  }
}

async function readStat({ files, cwd, operand }: {
  files: Pick<FileTestFiles, 'stat'>,
  cwd: string,
  operand: string,
}): Promise<WeshStat | undefined> {
  if (operand === '') {
    return undefined;
  }
  const path = toAbsolutePath({ cwd, path: operand });
  try {
    return await files.stat({ path });
  } catch {
    return undefined;
  }
}

export async function evaluateUnaryFileTest({ operator, operand, cwd, files }: {
  operator: UnaryFileTestOperator,
  operand: string,
  cwd: string,
  files: Pick<FileTestFiles, 'stat' | 'resolveEntry'>,
}): Promise<boolean> {
  const readEntry = () => resolveTestEntry({ files, cwd, operand, finalSymlinkTreatment: 'follow' });
  const readFollowedStat = () => readStat({ files, cwd, operand });
  switch (operator) {
  case '-t':
    // Wesh file descriptors do not expose terminal status.
    return false;
  case '-h':
  case '-L':
    return (await resolveTestEntry({ files, cwd, operand, finalSymlinkTreatment: 'no-follow' }))?.type === 'symlink';
  case '-e':
    return (await readEntry()) !== undefined;
  case '-d':
    return (await readEntry())?.type === 'directory';
  case '-f':
    return (await readEntry())?.type === 'file';
  case '-p':
    return (await readEntry())?.type === 'fifo';
  case '-c':
    return (await readEntry())?.type === 'chardev';
  case '-b':
  case '-S':
    return false;
  case '-s':
    return ((await readFollowedStat())?.size ?? 0) > 0;
  case '-r':
    return (((await readFollowedStat())?.mode ?? 0) & 0o444) !== 0;
  case '-w':
    return (((await readFollowedStat())?.mode ?? 0) & 0o222) !== 0;
  case '-x':
    return (((await readFollowedStat())?.mode ?? 0) & 0o111) !== 0;
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled unary file test: ${_ex}`);
  }
  }
}

export async function evaluateBinaryFileTest({ operator, leftOperand, rightOperand, cwd, files, checkActive }: {
  operator: BinaryFileTestOperator,
  leftOperand: string,
  rightOperand: string,
  cwd: string,
  files: FileTestFiles,
  checkActive?: () => void,
}): Promise<boolean> {
  switch (operator) {
  case '-ef': {
    if (leftOperand === '' || rightOperand === '') {
      return false;
    }
    const left = await resolveTestEntry({ files, cwd, operand: leftOperand, finalSymlinkTreatment: 'follow', pinBacking: true });
    checkActive?.();
    if (left === undefined) {
      return false;
    }
    const right = await resolveTestEntry({ files, cwd, operand: rightOperand, finalSymlinkTreatment: 'follow', pinBacking: true });
    checkActive?.();
    if (right === undefined) {
      return false;
    }
    try {
      const identity = await files.compareEntryIdentity({ first: left, second: right });
      return identity === 'same'
        || (identity === 'unknown' && left.type === right.type && left.fullPath === right.fullPath);
    } catch {
      return false;
    }
  }

  case '-nt':
  case '-ot': {
    const leftStat = await readStat({ files, cwd, operand: leftOperand });
    checkActive?.();
    const rightStat = await readStat({ files, cwd, operand: rightOperand });
    const newer = operator === '-nt';
    return newer
      ? leftStat !== undefined && (rightStat === undefined || leftStat.mtime > rightStat.mtime)
      : rightStat !== undefined && (leftStat === undefined || leftStat.mtime < rightStat.mtime);
  }
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled binary file test: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
