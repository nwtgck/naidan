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
    switch (this.currentToken.type) {
    case 'EOF':
      break;
    default: {
      const _ex: never = this.currentToken.type;
      throw new Error(`Unexpected token at end of command: ${this.currentToken.value}`);
    }
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
      let operator: ';' | '&&' | '||' | '&';
      switch (this.currentToken.type) {
      case 'SEMI':
        operator = ';';
        break;
      case 'AND':
        operator = '&&';
        break;
      case 'OR':
        operator = '||';
        break;
      case 'AMP':
        operator = '&';
        break;
      default: {
        const _ex: never = this.currentToken.type;
        throw new Error(`Unhandled operator type: ${_ex}`);
      }
      }

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

      switch (node.kind) {
      case 'pipeline':
        node.commands.push(right);
        break;
      case 'command':
        node = { kind: 'pipeline', commands: [node, right] };
        break;
      case 'list':
      case 'if':
      case 'for':
      case 'assignment':
      case 'subshell':
      case 'processSubstitution':
        throw new Error(`Invalid node kind in pipeline: ${node.kind}`);
      default: {
        const _ex: never = node;
        throw new Error(`Unhandled node kind: ${(_ex as WeshASTNode).kind}`);
      }
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
        const type = this.currentToken.type;
        this.eat(type);

        let redType: '>' | '>>' | '<' | '2>' | '2>&1' | '<<' | '<<<';
        let target: string | undefined;
        let content: string | undefined;

        switch (type) {
        case 'GT':
          redType = '>';
          target = this.expectWord();
          break;
        case 'GTGT':
          redType = '>>';
          target = this.expectWord();
          break;
        case 'LT':
          redType = '<';
          target = this.expectWord();
          break;
        case 'LTGT':
          redType = '2>';
          target = this.expectWord();
          break;
        case 'LTGTAMP':
          redType = '2>&1';
          target = undefined;
          break;
        case 'HERESTRING':
          redType = '<<<';
          target = this.expectWord();
          content = target;
          break;
        case 'HEREDOC':
          redType = '<<';
          target = this.expectWord();
          content = this.lexer.readHereDoc(target);
          break;
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled redirection type: ${_ex}`);
        }
        }
        redirections.push({ type: redType, target, content });

      } else if (this.currentToken.type === 'PROC_SUB_IN' || this.currentToken.type === 'PROC_SUB_OUT') {
        const type = this.currentToken.type;
        const kind = type === 'PROC_SUB_IN' ? 'input' : 'output';
        this.eat(type);

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
    const list = this.parseList();

    switch (this.currentToken.type) {
    case 'RPAREN':
      break;
    default: {
      const _ex: never = this.currentToken.type;
      throw new Error(`Expected ')', got: ${_ex}`);
    }
    }

    this.eat('RPAREN');

    let listNode: WeshListNode;
    switch (list.kind) {
    case 'list':
      listNode = list;
      break;
    case 'command':
    case 'pipeline':
    case 'if':
    case 'for':
    case 'assignment':
    case 'subshell':
    case 'processSubstitution':
      listNode = {
        kind: 'list',
        parts: [{ node: list, operator: ';' }]
      };
      break;
    default: {
      const _ex: never = list;
      throw new Error(`Unhandled node kind: ${(_ex as WeshASTNode).kind}`);
    }
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
