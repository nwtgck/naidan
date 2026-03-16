import { Lexer, Token, TokenType } from './lexer';
import {
  WeshASTNode,
  WeshCommandNode,
  WeshListNode,
  WeshPipelineNode,
  WeshIfNode,
  WeshForNode,
  WeshRedirection,
  WeshSubshellNode,
  WeshProcessSubstitutionNode
} from './types';

export function parseCommandLine({
  commandLine,
  env,
}: {
  commandLine: string;
  env: Map<string, string>;
}): WeshASTNode {
  const lexer = new Lexer(commandLine);
  const parser = new Parser(lexer);
  return parser.parse();
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done']);

class Parser {
  private currentToken: Token;
  private lexer: Lexer;

  constructor(lexer: Lexer) {
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

  parse(): WeshASTNode {
    const node = this.parseList();
    if (this.currentToken.type !== 'EOF') {
      throw new Error(`Unexpected token at end of command: ${this.currentToken.value}`);
    }
    return node;
  }

  private parseList(terminators: string[] = []): WeshASTNode {
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
    return (this.currentToken.type === 'WORD' && terminators.includes(this.currentToken.value)) ||
           this.currentToken.type === 'RPAREN';
  }

  private parsePipeline(terminators: string[] = []): WeshASTNode {
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

  private parseCommand(terminators: string[] = []): WeshASTNode {
    if (this.isTerminator(terminators)) {
      if (this.currentToken.type === 'RPAREN') {
        // Handled by caller (parseSubshell/parseList)
        return { kind: 'command', name: '', args: [], assignments: [], redirections: [] }; // Should not happen if logic is correct
      }
      throw new Error(`Unexpected terminator: ${this.currentToken.value}`);
    }

    // Subshell
    if (this.currentToken.type === 'LPAREN') {
      return this.parseSubshell();
    }

    if (this.currentToken.type === 'WORD') {
      if (this.currentToken.value === 'if') return this.parseIf();
      if (this.currentToken.value === 'for') return this.parseFor();

      if (KEYWORDS.has(this.currentToken.value)) {
        throw new Error(`Unexpected keyword: ${this.currentToken.value}`);
      }
    }

    const assignments: { key: string; value: string }[] = [];
    const args: Array<string | WeshProcessSubstitutionNode> = [];
    const redirections: WeshRedirection[] = [];
    let commandName: string | null = null;

    while (
      (this.currentToken.type === 'WORD' ||
        this.currentToken.type === 'GT' ||
        this.currentToken.type === 'GTGT' ||
        this.currentToken.type === 'LT' ||
        this.currentToken.type === 'LTGT' ||
        this.currentToken.type === 'LTGTAMP' ||
        this.currentToken.type === 'HEREDOC' ||
        this.currentToken.type === 'HERESTRING' ||
        this.currentToken.type === 'PROC_SUB_IN' ||
        this.currentToken.type === 'PROC_SUB_OUT') &&
        !this.isTerminator(terminators)
    ) {
      if (this.isRedirection(this.currentToken.type)) {
        const type = this.currentToken.type as 'GT' | 'GTGT' | 'LT' | 'LTGT' | 'LTGTAMP' | 'HEREDOC' | 'HERESTRING';
        this.eat(type);

        let redType: '>' | '>>' | '<' | '2>' | '2>&1' | '<<' | '<<<';
        let target: string | undefined;
        let content: string | undefined;

        switch(type) {
        case 'GT': redType = '>'; target = this.expectWord(); break;
        case 'GTGT': redType = '>>'; target = this.expectWord(); break;
        case 'LT': redType = '<'; target = this.expectWord(); break;
        case 'LTGT': redType = '2>'; target = this.expectWord(); break;
        case 'LTGTAMP': redType = '2>&1'; target = undefined; break;
        case 'HERESTRING': redType = '<<<'; target = this.expectWord(); content = target; break; // target is the string
        case 'HEREDOC':
          redType = '<<';
          target = this.expectWord();
          content = this.lexer.readHereDoc(target);
          break;
        default: throw new Error("Unknown redirection");
        }
        redirections.push({ type: redType, target, content });

      } else if (this.currentToken.type === 'PROC_SUB_IN' || this.currentToken.type === 'PROC_SUB_OUT') {
        const kind = this.currentToken.type === 'PROC_SUB_IN' ? 'input' : 'output';
        this.eat(this.currentToken.type);

        // Process substitution inner list: <( list )
        // We parse a list until RPAREN
        const list = this.parseList(['RPAREN']); // terminator is RPAREN?

        // Wait, parseList consumes everything until terminator or EOF.
        // If terminator is RPAREN, it stops when it sees RPAREN?
        // But parseList calls parsePipeline which calls parseCommand.
        // If parseCommand sees RPAREN, it stops?
        // My isTerminator includes RPAREN check now.

        if (this.currentToken.type !== 'RPAREN') {
          throw new Error("Expected ')' after process substitution");
        }
        this.eat('RPAREN');

        args.push({
          kind: 'processSubstitution',
          type: kind,
          list
        });

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
      // Could be just empty command or subshell processed earlier?
      // But loop condition handles words/redirections.
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

  private parseSubshell(): WeshSubshellNode {
    this.eat('LPAREN');
    const list = this.parseList(); // parse until EOF or RPAREN?

    // parseList loops until terminator or EOF.
    // parseList calls parsePipeline.
    // We need parseList to stop at RPAREN.
    // parseList uses isTerminator.
    // But parseList doesn't take terminators from here?
    // I need to pass RPAREN as terminator to parseList?
    // But parseList signature: (terminators: string[] = [])
    // RPAREN is a token type, not a WORD value.
    // My isTerminator implementation checks TokenType RPAREN.
    // So if I call parseList(), it checks isTerminator([]).
    // isTerminator([]) -> checks currentToken.type === RPAREN.
    // Yes, because I added RPAREN check in isTerminator.

    // However, parseList consumes terminators inside the loop?
    // No, parseList logic:
    // while (SEMI/AND/OR/AMP && !isTerminator)
    //   eat operator
    //   if (isTerminator) break

    // If next token is RPAREN, parseList returns.

    if (this.currentToken.type !== 'RPAREN') {
      // If parseList returned, it means it hit a terminator (RPAREN or EOF) or end of list.
      // If EOF, we expect RPAREN.
      throw new Error("Expected ')'");
    }

    this.eat('RPAREN');

    // Need to cast WeshASTNode to WeshListNode if possible?
    // WeshASTNode includes WeshListNode.
    // WeshSubshellNode expects 'list' of type WeshListNode?
    // Types definition: list: WeshListNode;
    // But parseList returns WeshASTNode.
    // If parseList returns a single command, it returns WeshCommandNode.
    // A single command is a valid list (conceptually).
    // But type-wise: WeshListNode has 'parts'.
    // I should wrap single node in WeshListNode if needed or update type.
    // types.ts says `list: WeshListNode`.
    // I should update types.ts to allow WeshASTNode or ensure parseList returns WeshListNode.
    // Better: Update types.ts to `list: WeshASTNode` for subshell.
    // Subshell can be `( cmd )`.

    // I will cast it for now or assume I updated types (I did update types.ts but subshell definition was `list: WeshListNode` in my thought).
    // Wait, let me check types.ts update.
    // `export interface WeshSubshellNode { kind: 'subshell'; list: WeshListNode; }`
    // If parseList returns WeshCommandNode, it doesn't match WeshListNode.
    // I should update types.ts to `list: WeshASTNode`?
    // Or wrap it here.

    let listNode: WeshListNode;
    if (list.kind === 'list') {
      listNode = list;
    } else {
      listNode = {
        kind: 'list',
        parts: [{ node: list, operator: ';' }]
      };
    }

    return {
      kind: 'subshell',
      list: listNode
    };
  }

  private parseIf(): WeshASTNode {
    this.eat('WORD'); // eat 'if'
    const condition = this.parseList(['then']);

    if (this.currentToken.type !== 'WORD' || this.currentToken.value !== 'then') {
      throw new Error("Expected 'then'");
    }
    this.eat('WORD'); // eat 'then'

    const thenBody = this.parseList(['else', 'elif', 'fi']);

    let elseBody: WeshASTNode | undefined;
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

  private parseFor(): WeshASTNode {
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
    return ['GT', 'GTGT', 'LT', 'LTGT', 'LTGTAMP', 'HEREDOC', 'HERESTRING'].includes(type);
  }
}
