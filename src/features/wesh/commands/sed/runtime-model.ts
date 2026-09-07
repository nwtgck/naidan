import type { WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import type { SedPreparedReadFileLine } from './read-file-manager';

export interface SedTextLine {
  line: string;
  hadNewline: boolean;
  sourceName: string;
}

export type SedProcessTermination =
  | { kind: "quit"; exitCode: number }
  | { kind: "fatal"; exitCode: 4 }
  | { kind: "interrupted" };

export interface SedLineResult {
  actions: SedAction[];
  termination: SedProcessTermination | undefined;
}

export interface SedSpace {
  text: string;
  hadNewline: boolean;
}

export interface SedOutput {
  text: string;
  hadNewline: boolean;
}

export type SedAction =
  | { kind: "output"; output: SedOutput }
  | { kind: "terminatePendingOutput" }
  | { kind: "appendText"; text: string }
  | { kind: "readFile"; path: string }
  | { kind: "readFileLine"; prepared: SedPreparedReadFileLine }
  | { kind: "writeFile"; path: string; output: SedOutput };

export interface SedExecutionState {
  holdSpace: SedSpace;
  characterLocaleMode: WeshCharacterLocaleMode;
}

export interface SedSeparateFileState {
  holdSpaceHadNewline: boolean;
}

export type SedInputReadPhase = "cycleStart" | "inCycle";

export interface SedInputReadState {
  phase: SedInputReadPhase;
}

export type SedInputFileIssue =
  | { kind: "directory" }
  | { kind: "readError"; error: unknown };


export const TEST_ONLY = {
};
