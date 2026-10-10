import ts from 'typescript';
import type { Effect } from '../contracts/effects.ts';
import type { EffectDefinition } from '../models/registry.ts';
import { EffectSyntaxError, parseEffects } from './expression.ts';
import { parseUnsafeSuppression, UNSAFE_SUPPRESSION_TAG, type UnsafeEffectSuppression } from './suppression.ts';

export type Annotation = { start: number, end: number, effects: readonly Effect[] };
type DirectiveComment = { start: number, end: number, text: string, offsets: readonly number[], tag: string, body: number };

/** Strip only JSDoc line decoration, preserving an exact source-offset map. */
function commentContent({ text, start, end }: { text: string, start: number, end: number }): { text: string, offsets: number[] } {
  let output = '';
  const offsets: number[] = [];
  let lineStart = false;
  for (let index = start + 3; index < end - 2; index++) {
    if (lineStart) {
      while (text[index] === ' ' || text[index] === '\t') index++;
      if (text[index] === '*') index++;
      lineStart = false;
    }
    if (index >= end - 2) break;
    output += text[index];
    offsets.push(index);
    if (text[index] === '\n' || text[index] === '\r') lineStart = true;
  }
  return { text: output, offsets };
}

/** Scan only parser-identified leading trivia, never literals or Markdown examples. */
function directiveComments({ anchor }: { anchor: ts.Node }): DirectiveComment[] {
  const source = anchor.getSourceFile();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false);
  scanner.setText(source.text, anchor.getFullStart(), anchor.getStart(source) - anchor.getFullStart());
  const result: DirectiveComment[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    if (!source.text.startsWith('/**', start) || source.text.startsWith('/**/', start)) continue;
    const content = commentContent({ text: source.text, start, end });
    let offset = 0;
    while (' \t\r\n'.includes(content.text[offset] ?? '\0')) offset++;
    if (!content.text.startsWith('@effects', offset)) continue;
    const begin = offset;
    while (offset < content.text.length && !' \t\r\n'.includes(content.text[offset]!)) offset++;
    result.push({ start, end, text: content.text, offsets: content.offsets, tag: content.text.slice(begin, offset), body: offset });
  }
  return result;
}

/** Dedicated comments only; the exception never replaces the public contract. */
export function readContractComments({ anchor, definitions }: { anchor: ts.Node, definitions: readonly EffectDefinition[] }): {
  annotation: Annotation | undefined, suppression: UnsafeEffectSuppression | undefined,
} {
  let annotation: Annotation | undefined;
  let suppression: UnsafeEffectSuppression | undefined;
  for (const comment of directiveComments({ anchor })) {
    const { start, end, text, offsets, tag, body, ...rest } = comment;
    rest satisfies Record<PropertyKey, never>;
    try {
      switch (tag) {
      case '@effects':
        if (annotation !== undefined) throw new EffectSyntaxError({ message: 'Multiple effect declarations for the same owner.', offset: -body });
        annotation = { start, end, effects: parseEffects({ text: text.slice(body), definitions }) };
        break;
      case UNSAFE_SUPPRESSION_TAG:
        if (suppression !== undefined) throw new EffectSyntaxError({ message: 'Multiple unsafe effect suppressions for the same owner.', offset: -body });
        suppression = { start, end, ...parseUnsafeSuppression({ text: text.slice(body), definitions }) };
        break;
      default:
        throw new EffectSyntaxError({ message: `Unknown effect directive: ${tag}.`, offset: -body });
      }
    } catch (error) {
      if (!(error instanceof EffectSyntaxError)) throw error;
      throw new EffectSyntaxError({ message: error.message, offset: offsets[body + error.offset] ?? start });
    }
  }
  return { annotation, suppression };
}

export function readAnnotation({ anchor, definitions }: { anchor: ts.Node, definitions: readonly EffectDefinition[] }): Annotation | undefined {
  return readContractComments({ anchor, definitions }).annotation;
}

/** Locate unowned exception directives as errors instead of silently ignoring them. */
export function unsafeDirectiveLocations({ source }: { source: ts.SourceFile }): readonly { start: number, end: number }[] {
  const found = new Map<number, { start: number, end: number }>();
  const visit = (node: ts.Node): void => {
    for (const comment of directiveComments({ anchor: node })) {
      if (comment.tag !== '@effects') found.set(comment.start, { start: comment.start, end: comment.end });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found.values()];
}
