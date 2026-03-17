import { Lexer } from './lexer';
import type { Token, TokenType } from './lexer';
import type {
  WeshASTNode,
  WeshListNode,
  WeshRedirection,
  WeshSubshellNode,
  WeshProcessSubstitutionNode
} from './types';

export function parseCommandLine({
  commandLine,
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
    const type = this.currentToken.type;
    switch (type) {
    case 'EOF':
      break;
    case 'WORD':
    case 'PIPE':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'LTGTAMP':
    case 'LPAREN':
    case 'RPAREN':
    case 'HEREDOC':
    case 'HERESTRING':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
      throw new Error(`Unexpected token at end of command: ${this.currentToken.value}`);
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled token type: ${_ex}`);
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
      const type = this.currentToken.type;
      let operator: ';' | '&&' | '||' | '&';

      switch (type) {
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
      default:
        throw new Error(`Unhandled operator type: ${type}`);
      }

      this.eat(type);

      if (this.isTerminator(terminators) || (this.currentToken.type as TokenType) === 'EOF') {
        const kind = node.kind;
        switch (kind) {
        case 'list': {
          const lastPart = node.parts[node.parts.length - 1];
          if (lastPart) lastPart.operator = operator;
          break;
        }
        case 'command':
        case 'pipeline':
        case 'if':
        case 'for':
        case 'assignment':
        case 'subshell':
          node = { kind: 'list', parts: [{ node, operator }] };
          break;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled node kind: ${_ex}`);
        }
        }
        return node;
      }

      const nextNode = this.parsePipeline(terminators);

      const kind = node.kind;
      switch (kind) {
      case 'list': {
        const lastPart = node.parts[node.parts.length - 1];
        if (lastPart) lastPart.operator = operator;
        node.parts.push({ node: nextNode, operator: ';' });
        break;
      }
      case 'command':
      case 'pipeline':
      case 'if':
      case 'for':
      case 'assignment':
      case 'subshell':
        node = {
          kind: 'list',
          parts: [
            { node, operator },
            { node: nextNode, operator: ';' }
          ]
        };
        break;
      default: {
        const _ex: never = kind;
        throw new Error(`Unhandled node kind: ${_ex}`);
      }
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

      const kind = node.kind;
      switch (kind) {
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
        throw new Error(`Invalid node kind in pipeline: ${kind}`);
      default: {
        const _ex: never = kind;
        throw new Error(`Unhandled node kind: ${_ex}`);
      }
      }
    }

    return node;
  }

  private parseCommand(terminators: string[] = []): WeshASTNode {
    if (this.isTerminator(terminators)) {
      const type = this.currentToken.type;
      switch (type) {
      case 'RPAREN':
        // Handled by caller (parseSubshell/parseList)
        return { kind: 'command', name: '', args: [], assignments: [], redirections: [] };
      case 'WORD':
      case 'PIPE':
      case 'AND':
      case 'OR':
      case 'SEMI':
      case 'AMP':
      case 'GT':
      case 'GTGT':
      case 'LT':
      case 'LTGT':
      case 'LTGTAMP':
      case 'LPAREN':
      case 'HEREDOC':
      case 'HERESTRING':
      case 'PROC_SUB_IN':
      case 'PROC_SUB_OUT':
      case 'EOF':
        throw new Error(`Unexpected terminator: ${this.currentToken.value}`);
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled token type: ${_ex}`);
      }
      }
    }

    // Subshell / Compound Commands
    const type = this.currentToken.type;
    if (type === 'LPAREN') {
      return this.parseSubshell();
    }
    if (type === 'WORD') {
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

    const canContinue = () => {
      const t = this.currentToken.type;
      return (
        t === 'WORD' ||
        t === 'GT' ||
        t === 'GTGT' ||
        t === 'LT' ||
        t === 'LTGT' ||
        t === 'LTGTAMP' ||
        t === 'HEREDOC' ||
        t === 'HERESTRING' ||
        t === 'PROC_SUB_IN' ||
        t === 'PROC_SUB_OUT'
      ) && !this.isTerminator(terminators);
    };

    while (canContinue()) {
      const t = this.currentToken.type;
      if (this.isRedirection(t)) {
        this.eat(t);

        let redType: '>' | '>>' | '<' | '2>' | '2>&1' | '<<' | '<<<';
        let target: string | undefined;
        let content: string | undefined;

        const redToken = t as 'GT' | 'GTGT' | 'LT' | 'LTGT' | 'LTGTAMP' | 'HEREDOC' | 'HERESTRING';
        switch (redToken) {
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
        default:
          throw new Error(`Unhandled redirection type: ${redToken}`);
        }
        redirections.push({ type: redType, target, content });

      } else if (t === 'PROC_SUB_IN' || t === 'PROC_SUB_OUT') {
        this.eat(t);

        const procSubToken = t as 'PROC_SUB_IN' | 'PROC_SUB_OUT';
        const kind: 'input' | 'output' = (() => {
          switch (procSubToken) {
          case 'PROC_SUB_IN': return 'input';
          case 'PROC_SUB_OUT': return 'output';
          default: {
            const _ex: never = procSubToken;
            throw new Error(`Unhandled process substitution: ${_ex}`);
          }
          }
        })();

        const list = this.parseList(['RPAREN']);

        const endType = this.currentToken.type;
        if (endType === 'RPAREN') {
          this.eat('RPAREN');
        } else {
          throw new Error(`Expected ')' after process substitution, got: ${this.currentToken.value}`);
        }

        args.push({
          kind: 'processSubstitution',
          type: kind,
          list
        });

      } else if (t === 'WORD') {
        const word = this.currentToken.value;

        if (commandName === null && KEYWORDS.has(word)) {
          break;
        }

        this.eat('WORD');

        if (commandName === null) {
          if (word.includes('=') && !word.startsWith('=')) {
            const parts = word.split('=');
            const key = parts[0];
            if (key) {
              assignments.push({ key, value: parts.slice(1).join('=') });
            } else {
              commandName = word;
            }
          } else {
            commandName = word;
          }
        } else {
          args.push(word);
        }
      } else {
        // Fallback for types that canContinue allows but we didn't handle specifically
        throw new Error(`Unexpected token in canContinue loop: ${t}`);
      }
    }

    if (commandName === null && assignments.length > 0) {
      return { kind: 'assignment', assignments };
    }

    if (commandName === null) {
      const t = this.currentToken.type;
      switch (t) {
      case 'WORD':
        throw new Error(`Expected command, got WORD: ${this.currentToken.value}`);
      case 'EOF':
        throw new Error("Expected command, got EOF");
      default:
        throw new Error(`Expected command, got token type: ${t}`);
      }
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
    default:
      throw new Error(`Expected ')', got: ${this.currentToken.value}`);
    }

    this.eat('RPAREN');

    let listNode: WeshListNode;
    const kind = list.kind;
    switch (kind) {
    case 'list':
      listNode = list;
      break;
    case 'command':
    case 'pipeline':
    case 'if':
    case 'for':
    case 'assignment':
    case 'subshell':
      listNode = {
        kind: 'list',
        parts: [{ node: list, operator: ';' }]
      };
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled node kind: ${_ex}`);
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

    if (this.currentToken.type !== 'WORD' || (this.currentToken.value as string) !== 'then') {
      throw new Error("Expected 'then'");
    }
    this.eat('WORD'); // eat 'then'

    const thenBody = this.parseList(['else', 'elif', 'fi']);

    let elseBody: WeshASTNode | undefined;
    if (this.currentToken.type === 'WORD' && (this.currentToken.value as string) === 'else') {
      this.eat('WORD');
      elseBody = this.parseList(['fi']);
    } else if (this.currentToken.type === 'WORD' && (this.currentToken.value as string) === 'elif') {
      this.currentToken.value = 'if';
      elseBody = this.parseIf();
      return {
        kind: 'if',
        condition,
        thenBody,
        elseBody
      };
    }

    if (this.currentToken.type !== 'WORD' || (this.currentToken.value as string) !== 'fi') {
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

    switch (this.currentToken.type) {
    case 'WORD':
      break;
    default:
      throw new Error("Expected variable name");
    }
    const variable = this.currentToken.value;
    this.eat('WORD');

    switch (this.currentToken.type) {
    case 'WORD':
      if ((this.currentToken.value as string) !== 'in') {
        throw new Error("Expected 'in'");
      }
      break;
    default:
      throw new Error("Expected 'in'");
    }
    this.eat('WORD');

    const items: string[] = [];
    while (this.currentToken.type === 'WORD' && (this.currentToken.value as string) !== 'do' && (this.currentToken.value as string) !== ';') {
      items.push(this.currentToken.value);
      this.eat('WORD');
    }

    // @ts-expect-error
    if (this.currentToken.type === 'SEMI') {
      this.eat('SEMI');
    }

    if (this.currentToken.type !== 'WORD' || (this.currentToken.value as string) !== 'do') {
      throw new Error("Expected 'do'");
    }
    this.eat('WORD');

    const body = this.parseList(['done']);

    if (this.currentToken.type !== 'WORD' || (this.currentToken.value as string) !== 'done') {
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
    switch (this.currentToken.type) {
    case 'WORD': {
      const val = this.currentToken.value;
      this.eat('WORD');
      return val;
    }
    default:
      throw new Error(`Expected word, got: ${this.currentToken.type}`);
    }
  }

  private isRedirection(type: TokenType): boolean {
    return ['GT', 'GTGT', 'LT', 'LTGT', 'LTGTAMP', 'HEREDOC', 'HERESTRING'].includes(type);
  }
}
