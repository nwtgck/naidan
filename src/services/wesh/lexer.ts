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

    if (char === '>') {
      if (nextChar === '>') {
        this.position += 2;
        return { type: 'GTGT', value: '>>', position: this.position - 2 };
      }
      this.position++;
      return { type: 'GT', value: '>', position: this.position - 1 };
    }

    if (char === '<') {
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
        char === '|' ||
        char === '&' ||
        char === ';' ||
        char === '>' ||
        char === '<' ||
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
}
