import { Lexer, Token, TokenType } from './lexer';
import { ASTNode, CommandNode, ListNode, PipelineNode, IfNode, ForNode, Redirection } from './types';

export function parseCommandLine({
  commandLine,
  env,
}: {
  commandLine: string;
  env: Record<string, string>;
}): ASTNode {
  const lexer = new Lexer(commandLine);
  const parser = new Parser(lexer, env);
  return parser.parse();
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done']);

class Parser {
  private currentToken: Token;
  private lexer: Lexer;

  constructor(lexer: Lexer, _env: Record<string, string>) {
    this.lexer = lexer;
    this.currentToken = this.lexer.next();
  }

  private eat(type: TokenType) {
    if (this.currentToken.type === type) {
      this.currentToken = this.lexer.next();
    } else {
      throw new Error(`Unexpected token: ${this.currentToken.value}, expected ${type}`);
    }
  }

  parse(): ASTNode {
    const node = this.parseList();
    if (this.currentToken.type !== 'EOF') {
        throw new Error(`Unexpected token at end of command: ${this.currentToken.value}`);
    }
    return node;
  }

  private parseList(terminators: string[] = []): ASTNode {
    let node = this.parsePipeline(terminators);

    while (
      (this.currentToken.type === 'SEMI' ||
      this.currentToken.type === 'AND' ||
      this.currentToken.type === 'OR' ||
      this.currentToken.type === 'AMP') &&
      !this.isTerminator(terminators)
    ) {
      const operator = this.currentToken.type === 'SEMI' ? ';'
        : this.currentToken.type === 'AND' ? '&&'
        : this.currentToken.type === 'OR' ? '||'
        : '&';
      
      this.eat(this.currentToken.type);

      if (this.isTerminator(terminators) || this.currentToken.type === 'EOF') {
         if (node.kind === 'list') {
             node.parts[node.parts.length - 1].operator = operator;
         } else {
             node = { kind: 'list', parts: [{ node, operator }] };
         }
         return node;
      }

      const nextNode = this.parsePipeline(terminators);

      if (node.kind === 'list') {
        node.parts[node.parts.length - 1].operator = operator;
        node.parts.push({ node: nextNode, operator: ';' }); 
      } else {
        node = {
          kind: 'list',
          parts: [
            { node, operator },
            { node: nextNode, operator: ';' } 
          ]
        };
      }
    }

    return node;
  }

  private isTerminator(terminators: string[]): boolean {
      return this.currentToken.type === 'WORD' && terminators.includes(this.currentToken.value);
  }

  private parsePipeline(terminators: string[] = []): ASTNode {
    let node = this.parseCommand(terminators);

    while (this.currentToken.type === 'PIPE' && !this.isTerminator(terminators)) {
      this.eat('PIPE');
      const right = this.parseCommand(terminators);
      
      if (node.kind === 'pipeline') {
        node.commands.push(right);
      } else {
        node = { kind: 'pipeline', commands: [node, right] };
      }
    }

    return node;
  }

  private parseCommand(terminators: string[] = []): ASTNode {
    if (this.isTerminator(terminators)) {
        throw new Error(`Unexpected terminator: ${this.currentToken.value}`);
    }

    if (this.currentToken.type === 'WORD') {
      if (this.currentToken.value === 'if') return this.parseIf();
      if (this.currentToken.value === 'for') return this.parseFor();
      
      if (KEYWORDS.has(this.currentToken.value)) {
          throw new Error(`Unexpected keyword: ${this.currentToken.value}`);
      }
    }

    const assignments: { key: string; value: string }[] = [];
    const args: string[] = [];
    const redirections: Redirection[] = [];
    let commandName: string | null = null;

    while (
        (this.currentToken.type === 'WORD' ||
        this.currentToken.type === 'GT' ||
        this.currentToken.type === 'GTGT' ||
        this.currentToken.type === 'LT' ||
        this.currentToken.type === 'LTGT' || 
        this.currentToken.type === 'LTGTAMP') &&
        !this.isTerminator(terminators)
    ) {
        if (this.isRedirection(this.currentToken.type)) {
            const type = this.currentToken.type as 'GT' | 'GTGT' | 'LT' | 'LTGT' | 'LTGTAMP';
            this.eat(type);
            
            let redType: '>' | '>>' | '<' | '2>' | '2>&1';
            let target: string | undefined;

            switch(type) {
                case 'GT': redType = '>'; target = this.expectWord(); break;
                case 'GTGT': redType = '>>'; target = this.expectWord(); break;
                case 'LT': redType = '<'; target = this.expectWord(); break;
                case 'LTGT': redType = '2>'; target = this.expectWord(); break;
                case 'LTGTAMP': redType = '2>&1'; target = undefined; break;
                default: throw new Error("Unknown redirection");
            }
            redirections.push({ type: redType, target });

        } else {
            const word = this.currentToken.value;
            
            if (commandName === null && KEYWORDS.has(word)) {
                break; 
            }

            this.eat('WORD');

            if (commandName === null) {
                if (word.includes('=') && !word.startsWith('=')) {
                    const [key, ...rest] = word.split('=');
                    assignments.push({ key, value: rest.join('=') });
                } else {
                    commandName = word;
                }
            } else {
                args.push(word);
            }
        }
    }

    if (commandName === null && assignments.length > 0) {
      return { kind: 'assignment', assignments };
    }

    if (commandName === null) {
        throw new Error("Expected command");
    }

    return {
      kind: 'command',
      name: commandName,
      args,
      assignments,
      redirections
    };
  }

  private parseIf(): ASTNode {
    this.eat('WORD'); // eat 'if'
    const condition = this.parseList(['then']); 
    
    if (this.currentToken.type !== 'WORD' || this.currentToken.value !== 'then') {
         throw new Error("Expected 'then'");
    }
    this.eat('WORD'); // eat 'then'

    const thenBody = this.parseList(['else', 'elif', 'fi']);

    let elseBody: ASTNode | undefined;
    if (this.currentToken.type === 'WORD' && this.currentToken.value === 'else') {
        this.eat('WORD');
        elseBody = this.parseList(['fi']);
    } else if (this.currentToken.type === 'WORD' && this.currentToken.value === 'elif') {
        this.currentToken.value = 'if'; 
        elseBody = this.parseIf();
        return {
            kind: 'if',
            condition,
            thenBody,
            elseBody
        };
    }

    if (this.currentToken.type !== 'WORD' || this.currentToken.value !== 'fi') {
        throw new Error("Expected 'fi'");
    }
    this.eat('WORD');

    return {
      kind: 'if',
      condition,
      thenBody,
      elseBody
    };
  }

  private parseFor(): ASTNode {
    this.eat('WORD'); // eat 'for'
    
    if (this.currentToken.type !== 'WORD') throw new Error("Expected variable name");
    const variable = this.currentToken.value;
    this.eat('WORD');

    if (this.currentToken.type !== 'WORD' || this.currentToken.value !== 'in') {
        throw new Error("Expected 'in'");
    }
    this.eat('WORD');

    const items: string[] = [];
    while (this.currentToken.type === 'WORD' && this.currentToken.value !== 'do' && this.currentToken.value !== ';') {
        items.push(this.currentToken.value);
        this.eat('WORD');
    }

    if (this.currentToken.type === 'SEMI') {
        this.eat('SEMI');
    }

    if (this.currentToken.type !== 'WORD' || this.currentToken.value !== 'do') {
        throw new Error("Expected 'do'");
    }
    this.eat('WORD');

    const body = this.parseList(['done']);

    if (this.currentToken.type !== 'WORD' || this.currentToken.value !== 'done') {
        throw new Error("Expected 'done'");
    }
    this.eat('WORD');

    return {
        kind: 'for',
        variable,
        items,
        body
    };
  }

  private expectWord(): string {
    if (this.currentToken.type === 'WORD') {
      const val = this.currentToken.value;
      this.eat('WORD');
      return val;
    }
    throw new Error("Expected word");
  }

  private isRedirection(type: TokenType): boolean {
      return ['GT', 'GTGT', 'LT', 'LTGT', 'LTGTAMP'].includes(type);
  }
}
