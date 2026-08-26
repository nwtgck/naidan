import {
  findBackquoteSubstitution,
  findBalancedParenthesizedExpression,
  findBracedParameterEnd,
} from './shell/scan';

export class ShellLexerIncompleteError extends Error {
}

export type TokenType =
  | 'WORD'
  | 'DLPAREN' // ((
  | 'PIPE' // |
  | 'AND' // &&
  | 'OR' // ||
  | 'SEMI' // ;
  | 'AMP' // &
  | 'GT' // >
  | 'GTGT' // >>
  | 'LT' // <
  | 'LTGT' // <>
  | 'DUP_OUT' // >&
  | 'DUP_IN' // <&
  | 'LPAREN' // (
  | 'RPAREN' // )
  | 'HEREDOC' // <<
  | 'HERESTRING' // <<<
  | 'PROC_SUB_IN' // <(
  | 'PROC_SUB_OUT' // >(
  | 'EOF';

export interface Token {
  type: TokenType,
  value: string,
  position: number,
}

export class Lexer {
  private input: string;
  private position: number = 0;
  private length: number;

  constructor({ input }: { input: string }) {
    this.input = input;
    this.length = input.length;
  }

  next(): Token {
    this.skipWhitespace();

    if (this.position >= this.length) {
      return { type: 'EOF', value: '', position: this.position };
    }

    const char = this.input[this.position];
    const nextChar = this.input[this.position + 1];

    if (char === '#') {
      while (this.position < this.length) {
        const commentChar = this.input[this.position];
        if (commentChar === '\n' || commentChar === '\r') break;
        this.position += 1;
      }

      if (this.position >= this.length) {
        return { type: 'EOF', value: '', position: this.position };
      }

      const newlinePosition = this.position;
      if (this.input[this.position] === '\r' && this.input[this.position + 1] === '\n') {
        this.position += 2;
      } else {
        this.position += 1;
      }
      return { type: 'SEMI', value: '\n', position: newlinePosition };
    }

    // Parentheses
    if (char === '(' && nextChar === '(') {
      this.position += 2;
      return { type: 'DLPAREN', value: '((', position: this.position - 2 };
    }
    if (char === '(') {
      this.position++;
      return { type: 'LPAREN', value: '(', position: this.position - 1 };
    }
    if (char === ')') {
      this.position++;
      return { type: 'RPAREN', value: ')', position: this.position - 1 };
    }

    // Operators and Redirections
    if (char === '|') {
      if (nextChar === '|') {
        this.position += 2;
        return { type: 'OR', value: '||', position: this.position - 2 };
      }
      this.position++;
      return { type: 'PIPE', value: '|', position: this.position - 1 };
    }

    if (char === '&') {
      if (nextChar === '&') {
        this.position += 2;
        return { type: 'AND', value: '&&', position: this.position - 2 };
      }
      if (nextChar === '>') {
        if (this.input[this.position + 2] === '>') {
          this.position += 3;
          return { type: 'GTGT', value: '&>>', position: this.position - 3 };
        }
        this.position += 2;
        return { type: 'GT', value: '&>', position: this.position - 2 };
      }
      this.position++;
      return { type: 'AMP', value: '&', position: this.position - 1 };
    }

    if (char === ';') {
      this.position++;
      return { type: 'SEMI', value: ';', position: this.position - 1 };
    }

    if (char === '\n' || char === '\r') {
      this.position++;
      return { type: 'SEMI', value: '\n', position: this.position - 1 };
    }

    if (char === '>') {
      if (nextChar === '(') {
        this.position += 2;
        return { type: 'PROC_SUB_OUT', value: '>(', position: this.position - 2 };
      }
      if (nextChar === '&') {
        this.position += 2;
        return { type: 'DUP_OUT', value: '>&', position: this.position - 2 };
      }
      if (nextChar === '>') {
        this.position += 2;
        return { type: 'GTGT', value: '>>', position: this.position - 2 };
      }
      this.position++;
      return { type: 'GT', value: '>', position: this.position - 1 };
    }

    if (char === '<') {
      if (nextChar === '(') {
        this.position += 2;
        return { type: 'PROC_SUB_IN', value: '<(', position: this.position - 2 };
      }
      if (nextChar === '&') {
        this.position += 2;
        return { type: 'DUP_IN', value: '<&', position: this.position - 2 };
      }
      if (nextChar === '>') {
        this.position += 2;
        return { type: 'LTGT', value: '<>', position: this.position - 2 };
      }
      if (nextChar === '<') {
        const thirdChar = this.input[this.position + 2];
        if (thirdChar === '<') {
          this.position += 3;
          return { type: 'HERESTRING', value: '<<<', position: this.position - 3 };
        }
        if (thirdChar === '-') {
          this.position += 3;
          return { type: 'HEREDOC', value: '<<-', position: this.position - 3 };
        }
        this.position += 2;
        return { type: 'HEREDOC', value: '<<', position: this.position - 2 };
      }
      this.position++;
      return { type: 'LT', value: '<', position: this.position - 1 };
    }

    // Words (including keywords, variable assignments, and quoted strings)
    return this.readWord();
  }

  private skipWhitespace() {
    while (
      this.position < this.length &&
      (this.input[this.position] === ' ' || this.input[this.position] === '\t')
    ) {
      this.position++;
    }
  }

  private readWord(): Token {
    const start = this.position;
    let inQuote: "'" | '"' | 'ansi-c' | null = null;
    let escaped = false;
    let extglobDepth = 0;

    while (this.position < this.length) {
      const char = this.input[this.position];

      switch (inQuote) {
      case "'":
        if (char === "'") {
          inQuote = null;
        }
        this.position++;
        continue;
      case 'ansi-c':
        if (char === '\\') {
          this.position += Math.min(2, this.length - this.position);
          continue;
        }
        if (char === "'") {
          inQuote = null;
        }
        this.position++;
        continue;
      case '"':
      case null:
        break;
      default: {
        const _ex: never = inQuote;
        throw new Error(`Unhandled quote mode: ${_ex}`);
      }
      }

      if (escaped) {
        escaped = false;
        this.position++;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        this.position++;
        continue;
      }

      if (char === '`') {
        const substitution = findBackquoteSubstitution({
          text: this.input,
          startIndex: this.position,
        });
        if (substitution === undefined) {
          throw new ShellLexerIncompleteError('Unterminated command substitution');
        }
        this.position = substitution.endIndex + 1;
        continue;
      }

      if (char === '$' && this.input[this.position + 1] === "'") {
        inQuote = 'ansi-c';
        this.position += 2;
        continue;
      }

      if (char === '$' && this.input[this.position + 1] === '(') {
        const nextNextChar = this.input[this.position + 2];
        if (nextNextChar === '(') {
          this.consumeArithmeticExpansion();
        } else {
          this.consumeCommandSubstitution();
        }
        continue;
      }

      if (char === '$' && this.input[this.position + 1] === '{') {
        const endIndex = findBracedParameterEnd({
          text: this.input,
          startIndex: this.position,
        });
        if (endIndex < 0) {
          throw new ShellLexerIncompleteError('Unterminated parameter expansion');
        }
        this.position = endIndex + 1;
        continue;
      }

      switch (inQuote) {
      case '"':
        if (char === '"') {
          inQuote = null;
        }
        this.position++;
        continue;
      case null:
        break;
      default: {
        const _ex: never = inQuote;
        throw new Error(`Unhandled quote mode: ${_ex}`);
      }
      }

      if (char === "'" || char === '"') {
        inQuote = char;
        this.position++;
        continue;
      }

      if (
        char !== undefined &&
        ['?', '*', '+', '@', '!'].includes(char) &&
        this.input[this.position + 1] === '('
      ) {
        extglobDepth += 1;
        this.position += 2;
        continue;
      }

      if (extglobDepth > 0) {
        if (char === ')') {
          extglobDepth -= 1;
        }
        this.position++;
        continue;
      }

      // Break on special characters (unless quoted/escaped)
      if (
        char === ' ' ||
        char === '\t' ||
        char === '\n' ||
        char === '\r' ||
        char === '|' ||
        char === '&' ||
        char === ';' ||
        char === '>' ||
        char === '<' ||
        char === '(' ||
        char === ')'
      ) {
        break;
      }

      this.position++;
    }

    switch (inQuote) {
    case null:
      break;
    case '"':
      throw new ShellLexerIncompleteError('Unterminated double quote');
    case "'":
    case 'ansi-c':
      throw new ShellLexerIncompleteError('Unterminated single quote');
    default: {
      const _ex: never = inQuote;
      throw new Error(`Unhandled quote mode: ${_ex}`);
    }
    }

    return { type: 'WORD', value: this.input.slice(start, this.position), position: start };
  }

  private consumeCommandSubstitution(): void {
    const expression = findBalancedParenthesizedExpression({
      text: this.input,
      startIndex: this.position + 1,
    });
    if (expression === undefined) {
      throw new ShellLexerIncompleteError('Unterminated command substitution');
    }
    this.position = expression.endIndex + 1;
  }

  private consumeArithmeticExpansion(): void {
    let depth = 1;
    let inQuote: "'" | '"' | null = null;
    let escaped = false;
    this.position += 3;

    while (this.position < this.length) {
      const char = this.input[this.position];
      const nextChar = this.input[this.position + 1];
      if (char === undefined) {
        break;
      }

      if (escaped) {
        escaped = false;
        this.position += 1;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        this.position += 1;
        continue;
      }

      if (inQuote !== null) {
        if (char === inQuote) {
          inQuote = null;
        }
        this.position += 1;
        continue;
      }

      if (char === "'" || char === '"') {
        inQuote = char;
        this.position += 1;
        continue;
      }

      if (char === '(') {
        depth += 1;
        this.position += 1;
        continue;
      }

      if (char === ')') {
        if (depth > 1) {
          depth -= 1;
          this.position += 1;
          continue;
        }
        if (nextChar === ')') {
          this.position += 2;
          return;
        }
      }

      this.position += 1;
    }

    throw new ShellLexerIncompleteError('Unterminated arithmetic expansion');
  }

  getPosition(): number {
    return this.position;
  }

  peek(): Token {
    const savedPosition = this.position;
    const token = this.next();
    this.position = savedPosition;
    return token;
  }

  readHereDoc({ delimiter, tabHandling }: {
    delimiter: string,
    tabHandling: 'preserve' | 'strip-leading',
  }): string {
    let content = '';

    // Simple line-based scanner
    while (this.position < this.length) {
      const lineStart = this.position;
      let lineEnd = this.input.indexOf('\n', lineStart);
      if (lineEnd === -1) lineEnd = this.length;

      const rawLine = this.input.slice(lineStart, lineEnd);
      const line = (() => {
        switch (tabHandling) {
        case 'preserve':
          return rawLine;
        case 'strip-leading':
          return rawLine.replace(/^\t+/u, '');
        default: {
          const _ex: never = tabHandling;
          throw new Error(`Unhandled here-document tab handling: ${_ex}`);
        }
        }
      })();

      if (line === delimiter) {
        this.position = lineEnd + (lineEnd < this.length ? 1 : 0); // Skip delimiter line and newline
        // Standard behavior: content is everything BEFORE the delimiter line.
        // If content ended with newline (which it does because we add it),
        // we might want to keep it or remove one.
        // Actually, my content += line + '\n' adds a newline for every line.
        // The last line before delimiter also got a newline.
        return content.endsWith('\n') ? content.slice(0, -1) : content;
      }

      content += line + '\n';
      this.position = lineEnd + (lineEnd < this.length ? 1 : 0);
    }

    throw new ShellLexerIncompleteError(`Here-document delimiter '${delimiter}' not found`);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
