import type { TailwindCandidateOccurrence } from './tw-class-core.mjs';

export type TailwindCandidateClassification = {
  candidates: string[],
  validCandidates: string[],
  generatedCandidates: string[],
  markerCandidates: string[],
  invalidCandidates: string[],
  generatedCss: (string | null)[],
};

export function compileTailwindCss(options: {
  cssEntryPath: string,
  candidates: string[],
  expectedTailwindVersion?: string,
}): Promise<{ css: string, tailwindVersion: string }>;

export function createTailwindCandidateValidator(options: {
  projectRoot: string,
  cssEntryPath: string,
  expectedTailwindVersion?: string,
}): Promise<{
  tailwindVersion: string,
  cssEntryPath: string,
  classify(options: { candidates: string[] }): TailwindCandidateClassification,
  getClassOrder(options: { candidates: string[] }): Map<string, bigint | null>,
  validate(options: { occurrences: TailwindCandidateOccurrence[] }): {
    candidates: string[],
    invalidCandidates: string[],
    generatedCssCount: number,
    markerCandidateCount: number,
  },
}>;
