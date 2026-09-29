import type { SyntaxHighlighter, SyntaxTokenKind } from '@/features/syntax-highlight/types';

const keywords = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'select', 'time', '!']);
const commandKeywords = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'time', '!']);
type Span = { kind: SyntaxTokenKind, start: number, end: number };
type Heredoc = { delimiter: string, stripTabs: boolean };
type QuoteMode = { type: 'quote', quote: string, escaped: boolean, span: number | undefined };
type ResumeMode = { type: 'normal' } | QuoteMode;
type Mode = ResumeMode
  | { type: 'word', span: number, eligible: boolean, candidate: string | undefined, assignment: 'name' | 'assigned' | 'other', escaped: boolean }
  | { type: 'comment', span: number }
  | { type: 'operator', span: number, text: string }
  | { type: 'variable-start', span: number, resume: ResumeMode }
  | { type: 'variable-name', span: number, resume: ResumeMode }
  | { type: 'parameter', span: number, depth: number, quote: string | undefined, escaped: boolean, resume: ResumeMode }
  | { type: 'delimiter', span: number, value: string[], quote: string | undefined, escaped: boolean, stripTabs: boolean }
  | { type: 'heredoc', span: number, lineStart: number, document: Heredoc };
type Context = {
  mode: Mode,
  commandPosition: boolean,
  redirectTarget: boolean,
  pendingHeredoc: { stripTabs: boolean } | undefined,
  heredocs: Heredoc[],
  parentheses: number,
};

function newContext(): Context {
  return { mode: { type: 'normal' }, commandPosition: true, redirectTarget: false, pendingHeredoc: undefined, heredocs: [], parentheses: 0 };
}

const testCounters = new WeakMap<SyntaxHighlighter, () => number>();

// This display lexer never validates or executes shell code. Appends continue
// unfinished lexical state, including long strings and heredoc payloads. A suffix
// replacement resets the lexer; no speculative checkpoint machinery is needed.
export function createShellHighlighter(): SyntaxHighlighter {
  let source = '';
  let cursor = 0;
  let changedFrom = 0;
  let spans: Span[] = [];
  let contexts = [newContext()];
  let examinedCharacters = 0;

  function begin({ kind }: { kind: SyntaxTokenKind }): number {
    spans.push({ kind, start: cursor, end: cursor });
    return spans.length - 1;
  }

  function take({ span }: { span: number }) {
    cursor++;
    spans[span]!.end = cursor;
    if (__BUILD_MODE_IS_TEST__) examinedCharacters++;
  }

  function character({ kind }: { kind: SyntaxTokenKind }) {
    const previous = spans.at(-1);
    const span = previous?.kind === kind ? spans.length - 1 : begin({ kind });
    take({ span });
  }

  function retag({ span, kind }: { span: number, kind: SyntaxTokenKind }) {
    const token = spans[span]!;
    if (token.kind === kind) return;
    token.kind = kind;
    changedFrom = Math.min(changedFrom, token.start);
  }

  function enterHeredoc({ context }: { context: Context }) {
    const document = context.heredocs.shift();
    context.mode = document
      ? { type: 'heredoc', span: begin({ kind: 'string' }), lineStart: cursor, document }
      : { type: 'normal' };
  }

  function wordKind({ mode }: { mode: Extract<Mode, { type: 'word' }> }): SyntaxTokenKind {
    if (!mode.eligible) return 'plain';
    switch (mode.assignment) {
    case 'assigned': return 'variable';
    case 'name':
    case 'other': break;
    default: {
      const _ex: never = mode.assignment;
      throw new Error(`Unhandled assignment state: ${_ex}`);
    }
    }
    return mode.candidate !== undefined && keywords.has(mode.candidate) ? 'keyword' : 'command';
  }

  function scan() {
    while (cursor < source.length) {
      const context = contexts.at(-1)!;
      const mode = context.mode;
      const char = source[cursor]!;
      switch (mode.type) {
      case 'normal': {
        if (/\s/.test(char)) {
          character({ kind: 'plain' });
          if (char === '\n') {
            context.commandPosition = true;
            context.redirectTarget = false;
            context.pendingHeredoc = undefined;
            enterHeredoc({ context });
          }
          break;
        }
        if (context.pendingHeredoc) {
          const { stripTabs } = context.pendingHeredoc;
          context.pendingHeredoc = undefined;
          if (!/[;|&()<>]/.test(char)) {
            context.mode = { type: 'delimiter', span: begin({ kind: 'string' }), value: [], quote: undefined, escaped: false, stripTabs };
            break;
          }
        }
        if (char === '#' && (cursor === 0 || /[\s;|&()]/.test(source[cursor - 1]!))) {
          context.mode = { type: 'comment', span: begin({ kind: 'comment' }) };
          break;
        }
        if (char === "'" || char === '"' || char === '`') {
          const span = begin({ kind: 'string' });
          take({ span });
          context.mode = { type: 'quote', quote: char, escaped: false, span };
          if (!context.redirectTarget) context.commandPosition = false;
          context.redirectTarget = false;
          break;
        }
        if (char === '$') {
          const span = begin({ kind: 'plain' });
          take({ span });
          context.mode = { type: 'variable-start', span, resume: { type: 'normal' } };
          if (!context.redirectTarget) context.commandPosition = false;
          context.redirectTarget = false;
          break;
        }
        if (char === ')' && contexts.length > 1 && context.parentheses === 0) {
          character({ kind: 'operator' });
          contexts.pop();
          break;
        }
        if (/[;|&()<>{}]/.test(char)) {
          if (char === '(') context.parentheses++;
          if (char === ')') context.parentheses = Math.max(0, context.parentheses - 1);
          const span = begin({ kind: 'operator' });
          take({ span });
          context.mode = { type: 'operator', span, text: char };
          break;
        }
        context.mode = { type: 'word', span: begin({ kind: 'plain' }), eligible: context.commandPosition && !context.redirectTarget, candidate: '', assignment: 'name', escaped: false };
        break;
      }
      case 'word': {
        if (!mode.escaped && /[\s'"`$;|&()<>{}]/.test(char)) {
          const kind = wordKind({ mode });
          if (mode.eligible) context.commandPosition = kind === 'variable' || (kind === 'keyword' && commandKeywords.has(mode.candidate!));
          context.redirectTarget = false;
          context.mode = { type: 'normal' };
          break;
        }
        if (mode.candidate !== undefined) {
          // Only short reserved words can change an already displayed command's color.
          mode.candidate = mode.candidate.length < 8 ? mode.candidate + char : undefined;
        }
        switch (mode.assignment) {
        case 'name': {
          const first = cursor === spans[mode.span]!.start;
          if (!first && char === '=') mode.assignment = 'assigned';
          else if (!(first ? /[A-Za-z_]/ : /[A-Za-z0-9_]/).test(char)) mode.assignment = 'other';
          break;
        }
        case 'assigned':
        case 'other': break;
        default: { const _ex: never = mode.assignment; throw new Error('Unhandled assignment state: ' + _ex); }
        }
        mode.escaped = !mode.escaped && char === '\\';
        take({ span: mode.span });
        retag({ span: mode.span, kind: wordKind({ mode }) });
        break;
      }
      case 'comment':
        if (char === '\n') context.mode = { type: 'normal' };
        else take({ span: mode.span });
        break;
      case 'quote': {
        if (!mode.escaped && mode.quote === '"' && char === '$') {
          const span = begin({ kind: 'string' });
          take({ span });
          context.mode = { type: 'variable-start', span, resume: { ...mode, span: undefined } };
          break;
        }
        mode.span ??= begin({ kind: 'string' });
        take({ span: mode.span });
        if (mode.escaped) mode.escaped = false;
        else if (char === '\\' && mode.quote !== "'") mode.escaped = true;
        else if (char === mode.quote) context.mode = { type: 'normal' };
        break;
      }
      case 'operator': {
        if ((mode.text.length === 1 && char === mode.text && /[;|&<>]/.test(char))
          || (mode.text === '<<' && (char === '<' || char === '-'))
          || ((mode.text === '<' || mode.text === '>') && char === '&')) {
          mode.text += char;
          take({ span: mode.span });
          break;
        }
        if (mode.text.startsWith('<') || mode.text.startsWith('>')) {
          context.redirectTarget = true;
          if (mode.text === '<<' || mode.text === '<<-') context.pendingHeredoc = { stripTabs: mode.text === '<<-' };
        } else {
          context.commandPosition = true;
          context.redirectTarget = false;
        }
        context.mode = { type: 'normal' };
        break;
      }
      case 'variable-start': {
        if (char === '(') {
          retag({ span: mode.span, kind: 'operator' });
          take({ span: mode.span });
          context.mode = mode.resume;
          // A nested shell context returns to its surrounding quote/word context.
          contexts.push(newContext());
        } else if (char === '{') {
          retag({ span: mode.span, kind: 'variable' });
          take({ span: mode.span });
          context.mode = { type: 'parameter', span: mode.span, depth: 1, quote: undefined, escaped: false, resume: mode.resume };
        } else if (/[A-Za-z_]/.test(char)) {
          retag({ span: mode.span, kind: 'variable' });
          take({ span: mode.span });
          context.mode = { type: 'variable-name', span: mode.span, resume: mode.resume };
        } else if (/[0-9?@*#$!-]/.test(char)) {
          retag({ span: mode.span, kind: 'variable' });
          take({ span: mode.span });
          context.mode = mode.resume;
        } else context.mode = mode.resume;
        break;
      }
      case 'variable-name':
        if (/[A-Za-z0-9_]/.test(char)) take({ span: mode.span });
        else context.mode = mode.resume;
        break;
      case 'parameter': {
        // Parameter expansion stays opaque; command substitutions have their own
        // shell context above, rather than coloring their entire body as a variable.
        take({ span: mode.span });
        if (mode.escaped) mode.escaped = false;
        else if (char === '\\' && mode.quote !== "'") mode.escaped = true;
        else if (mode.quote) {
          if (char === mode.quote) mode.quote = undefined;
        } else if (char === "'" || char === '"') mode.quote = char;
        else if (char === '{') mode.depth++;
        else if (char === '}' && --mode.depth === 0) context.mode = mode.resume;
        break;
      }
      case 'delimiter': {
        if (!mode.escaped && !mode.quote && /[\s;|&()<>]/.test(char)) {
          context.heredocs.push({ delimiter: mode.value.join(''), stripTabs: mode.stripTabs });
          context.redirectTarget = false;
          context.mode = { type: 'normal' };
          break;
        }
        take({ span: mode.span });
        if (mode.escaped) {
          mode.value.push(char); mode.escaped = false;
        } else if (char === '\\' && mode.quote !== "'") mode.escaped = true;
        else if (mode.quote) {
          if (char === mode.quote) mode.quote = undefined;
          else mode.value.push(char);
        } else if (char === "'" || char === '"') mode.quote = char;
        else mode.value.push(char);
        break;
      }
      case 'heredoc': {
        // Even a long, unfinished HTML line is consumed only once. Check its
        // delimiter at the newline; payload contents are never parsed as shell.
        take({ span: mode.span });
        if (char === '\n') {
          let line = source.slice(mode.lineStart, cursor - 1).replace(/\r$/, '');
          if (mode.document.stripTabs) line = line.replace(/^\t+/, '');
          if (__BUILD_MODE_IS_TEST__) examinedCharacters += cursor - 1 - mode.lineStart;
          if (line === mode.document.delimiter) enterHeredoc({ context });
          else mode.lineStart = cursor;
        }
        break;
      }
      default: { const _ex: never = mode; throw new Error('Unhandled shell mode: ' + _ex); }
      }
    }
  }

  const highlighter: SyntaxHighlighter = {
    update({ edit }) {
      const { offset, text, ...unhandled } = edit;
      unhandled satisfies Record<PropertyKey, never>;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new Error('Invalid code edit offset');
      changedFrom = offset;
      if (offset !== source.length) {
        cursor = 0;
        spans = [];
        contexts = [newContext()];
        changedFrom = 0;
      }
      source = source.slice(0, offset) + text;
      scan();
      // Find the changed suffix without revisiting all earlier tokens per append.
      let first = spans.length;
      while (first > 0 && spans[first - 1]!.end > changedFrom) first--;
      const tokens = spans.slice(first).filter(span => span.end > span.start).map(({ kind, start, end }) => ({ kind, text: source.slice(Math.max(changedFrom, start), end) }));
      return { offset: changedFrom, tokens };
    },
  };
  if (__BUILD_MODE_IS_TEST__) testCounters.set(highlighter, () => examinedCharacters);
  return highlighter;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
  examinedCharacters({ highlighter }: { highlighter: SyntaxHighlighter }): number {
    const count = testCounters.get(highlighter);
    if (!count) throw new Error('Highlighter instrumentation is unavailable');
    return count();
  },
};
