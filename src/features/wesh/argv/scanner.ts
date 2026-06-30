export class ArgvScanner {
  private readonly tokens: string[];
  private index: number;

  constructor({ tokens }: { tokens: string[] }) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek(): string | undefined {
    return this.tokens[this.index];
  }

  peekNext(): string | undefined {
    return this.tokens[this.index + 1];
  }

  next(): string | undefined {
    const token = this.tokens[this.index];
    if (token !== undefined) {
      this.index += 1;
    }
    return token;
  }

  consumeMany({ count }: { count: number }): void {
    this.index += count;
  }

  consumeRest(): string[] {
    const rest = this.tokens.slice(this.index);
    this.index = this.tokens.length;
    return rest;
  }

  hasMore(): boolean {
    return this.index < this.tokens.length;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
