import type { NodeTransform, RootNode } from '@vue/compiler-core';

export type TailwindCandidateOccurrence = {
  candidate: string,
  column: number,
  filename: string,
  line: number,
  sourceKind: string,
};

export function parseStaticTwClassExpression(options: {
  expression: string,
  filename: string,
  loc?: unknown,
}): string[];
export function createTwClassNodeTransform(options?: { filename?: string }): NodeTransform;
export function collectTwCandidateOccurrencesFromVueSource(options: { source: string, filename: string }): TailwindCandidateOccurrence[];
export function transformTwCallsInModule(options: {
  source: string,
  filename: string,
  sourceType?: 'javascript' | 'typescript',
  blockStart?: { line: number, column: number },
  additionalImports?: string[],
}): { code: string, map: unknown, classes: Set<string>, occurrences: TailwindCandidateOccurrence[], changed: boolean };
export function transformTwCallsInVueSource(options: {
  source: string,
  filename: string,
  additionalImports?: string[],
}): { code: string, map: unknown, changed: boolean };
export function collectTwCandidateOccurrencesFromTemplateAst(options: {
  ast: RootNode,
  filename: string,
  blockStart?: { line: number, column: number },
}): TailwindCandidateOccurrence[];
