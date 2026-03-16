export type TokenType =
  | 'WORD'
  | 'PIPE' // |
  | 'AND' // &&
  | 'OR' // ||
  | 'SEMI' // ;
  | 'AMP' // &
  | 'GT' // >
  | 'GTGT' // >>
  | 'LT' // <
  | 'LTGT' // 2>
  | 'LTGTAMP' // 2>&1
  | 'LPAREN' // (
  | 'RPAREN' // )
  | 'HEREDOC' // <<
  | 'HERESTRING' // <<<
  | 'PROC_SUB_IN' // <(
  | 'PROC_SUB_OUT' // >(
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}

export class Lexer {
  private input: string;
  private position: number = 0;
  private length: number;

  constructor(input: string) {
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

    // Parentheses
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
      this.position++;
      return { type: 'AMP', value: '&', position: this.position - 1 };
    }

    if (char === ';') {
      this.position++;
      return { type: 'SEMI', value: ';', position: this.position - 1 };
    }

    if (char === '\n' || char === '\r') {
      this.position++;
      return { type: 'SEMI', value: ';', position: this.position - 1 };
    }

    if (char === '>') {
      if (nextChar === '(') {
        this.position += 2;
        return { type: 'PROC_SUB_OUT', value: '>(', position: this.position - 2 };
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
      if (nextChar === '<') {
        const thirdChar = this.input[this.position + 2];
        if (thirdChar === '<') {
          this.position += 3;
          return { type: 'HERESTRING', value: '<<<', position: this.position - 3 };
        }
        this.position += 2;
        return { type: 'HEREDOC', value: '<<', position: this.position - 2 };
      }
      this.position++;
      return { type: 'LT', value: '<', position: this.position - 1 };
    }

    // 2> and 2>&1
    if (char === '2' && nextChar === '>') {
      const thirdChar = this.input[this.position + 2];
      const fourthChar = this.input[this.position + 3];

      if (thirdChar === '&' && fourthChar === '1') {
        this.position += 4;
        return { type: 'LTGTAMP', value: '2>&1', position: this.position - 4 };
      }

      this.position += 2;
      return { type: 'LTGT', value: '2>', position: this.position - 2 };
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
    let value = '';
    let inQuote: "'" | '"' | null = null;
    let escaped = false;

    while (this.position < this.length) {
      const char = this.input[this.position];

      if (escaped) {
        value += char;
        escaped = false;
        this.position++;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        this.position++;
        continue;
      }

      if (inQuote) {
        if (char === inQuote) {
          inQuote = null;
        } else {
          value += char;
        }
        this.position++;
        continue;
      }

      if (char === "'" || char === '"') {
        inQuote = char;
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
        char === ')' ||
        (char === '2' && this.input[this.position + 1] === '>') // Start of 2> or 2>&1
      ) {
        break;
      }

      value += char;
      this.position++;
    }

    return { type: 'WORD', value, position: start };
  }

  peek(): Token {
    const savedPosition = this.position;
    const token = this.next();
    this.position = savedPosition;
    return token;
  }

  readHereDoc(delimiter: string): string {
    const start = this.position;
    let content = '';
    
    // Simple line-based scanner
    while (this.position < this.length) {
      const lineStart = this.position;
      let lineEnd = this.input.indexOf('\n', lineStart);
      if (lineEnd === -1) lineEnd = this.length;
      
      const line = this.input.slice(lineStart, lineEnd);
      
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
    
    throw new Error(`Here-document delimiter '${delimiter}' not found`);
  }
}
