import { parse as parseSfc, type SFCTemplateBlock } from '@vue/compiler-sfc';
import type { Effect } from '../contracts/effects.ts';
import type { EffectDefinition } from '../models/registry.ts';
import { EffectSyntaxError, effectRowValues, parseEffectRow } from './expression.ts';
import { parseJsonPayload } from './json.ts';
import { effectEventMapSchema, parseEffectMetadata } from './schema.ts';

type TemplateRoot = NonNullable<SFCTemplateBlock['ast']>;
type TemplateChild = TemplateRoot['children'][number];
type TemplateElement = Extract<TemplateChild, { type: 1 }>;
type TemplateComment = Extract<TemplateChild, { type: 3 }>;

export type VueEventEffectContract = {
  event: string;
  effects: readonly Effect[];
  commentStart: number;
  commentEnd: number;
  elementStart: number;
  elementEnd: number;
  handlers: readonly {
    start: number;
    end: number;
    expression: string | undefined;
    expressionStart: number | undefined;
    expressionEnd: number | undefined;
    modifiers: readonly string[];
  }[];
};

export function parseVueEventEffects({ text, definitions }: {
  text: string;
  definitions: readonly EffectDefinition[];
}): ReadonlyMap<string, readonly Effect[]> {
  const value = parseEffectMetadata({ schema: effectEventMapSchema, value: parseJsonPayload({ text }) });
  const result = new Map<string, readonly Effect[]>();
  for (const [selector, row] of Object.entries(value)) {
    if (!selector.startsWith('@') || selector.length === 1) {
      throw new EffectSyntaxError({ message: 'Vue effect event selectors must start with @ and include a static event name.', offset: 0 });
    }
    try {
      result.set(selector, parseEffectRow({ value: row, definitions }));
    } catch (error) {
      if (!(error instanceof EffectSyntaxError)) throw error;
      throw new EffectSyntaxError({ message: `${selector}: ${error.message}`, offset: 0 });
    }
  }
  return result;
}

/** Print the JSON payload without introducing an HTML comment delimiter. */
export function printVueEventEffects({ events }: { events: ReadonlyMap<string, readonly Effect[]> }): string {
  const rows = [...events].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([selector, effects]) => [selector, effectRowValues({ effects })]);
  return JSON.stringify(Object.fromEntries(rows)).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function commentEffects({ comment, definitions }: {
  comment: TemplateComment;
  definitions: readonly EffectDefinition[];
}): ReadonlyMap<string, readonly Effect[]> | undefined {
  let position = 0;
  while (' \t\r\n'.includes(comment.content[position] ?? '\0')) position++;
  if (!comment.content.startsWith('@effects', position)) return undefined;
  const start = position;
  while (position < comment.content.length && !' \t\r\n'.includes(comment.content[position]!)) position++;
  if (comment.content.slice(start, position) !== '@effects') {
    throw new EffectSyntaxError({ message: 'Unknown Vue effect directive.', offset: comment.loc.start.offset + 4 + start });
  }
  try {
    return parseVueEventEffects({ text: comment.content.slice(position), definitions });
  } catch (error) {
    if (!(error instanceof EffectSyntaxError)) throw error;
    throw new EffectSyntaxError({ message: error.message, offset: comment.loc.start.offset + 4 + position + error.offset });
  }
}

/** Read syntax and source bindings only; this does not effect-verify a Vue SFC. */
export function readVueTemplateEffects({ source, filename, definitions }: {
  source: string;
  filename: string;
  definitions: readonly EffectDefinition[];
}): readonly VueEventEffectContract[] {
  const parsed = parseSfc(source, { filename, templateParseOptions: { comments: true, expressionPlugins: ['typescript'] } });
  const firstError = parsed.errors[0];
  if (firstError !== undefined) {
    throw new EffectSyntaxError({ message: firstError.message, offset: 'loc' in firstError ? firstError.loc?.start.offset ?? 0 : 0 });
  }
  const template = parsed.descriptor.template;
  if (template === null) return [];
  if (template.src !== undefined || template.lang !== undefined && template.lang !== 'html') {
    throw new EffectSyntaxError({ message: 'Vue event effect comments require an inline HTML template.', offset: template.loc.start.offset });
  }
  if (template.ast === undefined) throw new EffectSyntaxError({ message: 'The Vue compiler did not provide a template AST.', offset: template.loc.start.offset });
  const result: VueEventEffectContract[] = [];
  type Pending = { comment: TemplateComment; events: ReadonlyMap<string, readonly Effect[]> };
  const bind = ({ element, pending }: { element: TemplateElement; pending: readonly Pending[] }): void => {
    if (pending.length > 0 && element.props.some(property => property.type === 7 && property.name === 'on' && (property.arg?.type !== 4 || !property.arg.isStatic))) {
      throw new EffectSyntaxError({ message: 'Vue event effect comments cannot bind an element with dynamic event names or an object of listeners.', offset: element.loc.start.offset });
    }
    const declared = new Set<string>();
    for (const { comment, events } of pending) {
      for (const [event, effects] of events) {
        if (declared.has(event)) throw new EffectSyntaxError({ message: `Multiple effect declarations for Vue event ${event}.`, offset: comment.loc.start.offset });
        declared.add(event);
        const directives = element.props.filter(property => property.type === 7 && property.name === 'on' && property.arg?.type === 4 && property.arg.isStatic && '@' + property.arg.content === event);
        if (directives.length === 0) throw new EffectSyntaxError({ message: `No matching static Vue event ${event} on the following element. Select the base event name without modifiers.`, offset: comment.loc.start.offset });
        result.push({
          event,
          effects,
          commentStart: comment.loc.start.offset,
          commentEnd: comment.loc.end.offset,
          elementStart: element.loc.start.offset,
          elementEnd: element.loc.end.offset,
          handlers: directives.map(directive => ({
            start: directive.loc.start.offset,
            end: directive.loc.end.offset,
            expression: directive.type === 7 && directive.exp?.type === 4 ? directive.exp.content : undefined,
            expressionStart: directive.type === 7 ? directive.exp?.loc.start.offset : undefined,
            expressionEnd: directive.type === 7 ? directive.exp?.loc.end.offset : undefined,
            modifiers: directive.type === 7 ? directive.modifiers.map(modifier => modifier.content) : [],
          })),
        });
      }
    }
  };
  const orphan = ({ pending }: { pending: readonly Pending[] }): void => {
    const first = pending[0];
    if (first !== undefined) throw new EffectSyntaxError({ message: 'Vue effect comments must precede an element in the same parent.', offset: first.comment.loc.start.offset });
  };
  const visit = ({ children }: { children: readonly TemplateChild[] }): void => {
    let pending: Pending[] = [];
    for (const child of children) {
      // Numeric discriminants are the public Vue AST node types exposed by compiler-sfc.
      if (child.type === 3) {
        const events = commentEffects({ comment: child, definitions });
        if (events !== undefined) pending.push({ comment: child, events });
        continue;
      }
      if (child.type === 2 && child.content.trim().length === 0) continue;
      if (child.type === 1) {
        bind({ element: child, pending });
        pending = [];
        visit({ children: child.children });
        continue;
      }
      orphan({ pending });
    }
    orphan({ pending });
  };
  visit({ children: template.ast.children });
  return result;
}
