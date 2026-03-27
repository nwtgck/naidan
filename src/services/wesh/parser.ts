import { Lexer } from './lexer';
import type { Token, TokenType } from './lexer';
import type {
  WeshASTNode,
  WeshCaseClause,
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

const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'in', 'do', 'done',
  'while', 'until',
  'case', 'esac',
  'function',
]);

function parseHereDocDelimiter({
  raw,
}: {
  raw: string;
}): {
  delimiter: string;
  contentExpansion: 'literal' | 'variables';
} {
  let delimiter = '';
  let mode: 'unquoted' | 'single' | 'double' = 'unquoted';

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === undefined) continue;

    switch (mode) {
    case 'single':
      if (char === "'") {
        mode = 'unquoted';
      } else {
        delimiter += char;
      }
      continue;
    case 'double':
      if (char === '"') {
        mode = 'unquoted';
      } else if (char === '\\') {
        const nextChar = raw[index + 1];
        if (nextChar !== undefined) {
          delimiter += nextChar;
          index += 1;
        }
      } else {
        delimiter += char;
      }
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled parser mode: ${_ex}`);
    }
    }

    if (char === "'") {
      mode = 'single';
      continue;
    }

    if (char === '"') {
      mode = 'double';
      continue;
    }

    if (char === '\\') {
      const nextChar = raw[index + 1];
      if (nextChar !== undefined) {
        delimiter += nextChar;
        index += 1;
      }
      continue;
    }

    delimiter += char;
  }

  return {
    delimiter,
    contentExpansion: raw === delimiter ? 'variables' : 'literal',
  };
}

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

  private parseProcessSubstitution({
    tokenType,
  }: {
    tokenType: 'PROC_SUB_IN' | 'PROC_SUB_OUT';
  }): WeshProcessSubstitutionNode {
    this.eat(tokenType);

    const kind: 'input' | 'output' = (() => {
      switch (tokenType) {
      case 'PROC_SUB_IN':
        return 'input';
      case 'PROC_SUB_OUT':
        return 'output';
      default: {
        const _ex: never = tokenType;
        throw new Error(`Unhandled process substitution: ${_ex}`);
      }
      }
    })();

    const list = this.parseList(['RPAREN']);

    const endType = this.currentToken.type;
    switch (endType) {
    case 'RPAREN':
      this.eat('RPAREN');
      break;
    case 'WORD':
    case 'LPAREN':
    case 'PIPE':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'DLPAREN':
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'DUP_OUT':
    case 'DUP_IN':
    case 'HEREDOC':
    case 'HERESTRING':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
    case 'EOF':
      throw new Error(`Expected ')' after process substitution, got: ${this.currentToken.value}`);
    default: {
      const _ex: never = endType;
      throw new Error(`Unhandled token type: ${_ex}`);
    }
    }

    return {
      kind: 'processSubstitution',
      type: kind,
      list,
    };
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
    case 'DLPAREN':
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'DUP_OUT':
    case 'DUP_IN':
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
    while (this.currentToken.type === 'SEMI' && !this.isTerminator(terminators)) {
      this.eat('SEMI');
    }

    if (this.isTerminator(terminators) || this.currentToken.type === 'EOF') {
      return {
        kind: 'list',
        parts: [],
      };
    }

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
      while (this.currentToken.type === 'SEMI' && !this.isTerminator(terminators)) {
        this.eat('SEMI');
      }

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
        case 'while':
        case 'until':
        case 'case':
        case 'functionDefinition':
        case 'arithmeticCommand':
        case 'redirected':
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
      case 'while':
      case 'until':
      case 'case':
      case 'functionDefinition':
      case 'arithmeticCommand':
      case 'redirected':
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
      case 'while':
      case 'until':
      case 'case':
      case 'functionDefinition':
      case 'arithmeticCommand':
      case 'redirected':
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
      case 'DLPAREN':
      case 'GT':
      case 'GTGT':
      case 'LT':
      case 'LTGT':
      case 'DUP_OUT':
      case 'DUP_IN':
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
    switch (type) {
    case 'LPAREN':
    case 'DLPAREN':
    case 'WORD': {
      const compoundNode = this.tryParseCompoundCommand();
      if (compoundNode !== undefined) {
        return this.parseTrailingCompoundRedirections({
          node: compoundNode,
        });
      }
      if (type === 'WORD' && KEYWORDS.has(this.currentToken.value)) {
        throw new Error(`Unexpected keyword: ${this.currentToken.value}`);
      }
      break;
    }
    case 'PIPE':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'DUP_OUT':
    case 'DUP_IN':
    case 'HEREDOC':
    case 'HERESTRING':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
    case 'EOF':
    case 'RPAREN':
      break;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled token type: ${_ex}`);
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
        t === 'DUP_OUT' ||
        t === 'DUP_IN' ||
        t === 'HEREDOC' ||
        t === 'HERESTRING' ||
        t === 'PROC_SUB_IN' ||
        t === 'PROC_SUB_OUT'
      ) && !this.isTerminator(terminators);
    };

    while (canContinue()) {
      const t = this.currentToken.type;
      if (this.isRedirectionStart()) {
        redirections.push(this.parseRedirection());

      } else if (t === 'PROC_SUB_IN' || t === 'PROC_SUB_OUT') {
        args.push(this.parseProcessSubstitution({
          tokenType: t as 'PROC_SUB_IN' | 'PROC_SUB_OUT',
        }));

      } else {
        switch (t) {
        case 'WORD': {
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
          break;
        }
        case 'GT':
        case 'GTGT':
        case 'LT':
        case 'LTGT':
        case 'DUP_OUT':
        case 'DUP_IN':
        case 'HEREDOC':
        case 'HERESTRING':
        case 'DLPAREN':
          // Handled by isRedirection or ProcSub blocks
          break;
        case 'PIPE':
        case 'AND':
        case 'OR':
        case 'SEMI':
        case 'AMP':
        case 'LPAREN':
        case 'RPAREN':
        case 'EOF':
          throw new Error(`Unexpected token in canContinue loop: ${t}`);
        default: {
          const _ex: never = t;
          throw new Error(`Unhandled token type: ${_ex}`);
        }
        }
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

  private tryParseCompoundCommand(): WeshASTNode | undefined {
    switch (this.currentToken.type) {
    case 'LPAREN':
      return this.parseSubshell();
    case 'DLPAREN':
      return this.parseArithmeticCommand();
    case 'WORD': {
      const val = this.currentToken.value;
      if (val === '[[') {
        return this.parseExtendedTestCommand();
      }
      if (val === 'if') return this.parseIf();
      if (val === 'for') return this.parseFor();
      if (val === 'while') return this.parseWhile();
      if (val === 'until') return this.parseUntil();
      if (val === 'case') return this.parseCase();
      if (val === 'function') return this.parseFunctionDefinition({ usedFunctionKeyword: true });
      const peekType = this.lexer.peek().type;
      switch (peekType) {
      case 'LPAREN':
        return this.parseFunctionDefinition({ usedFunctionKeyword: false });
      case 'WORD':
      case 'DLPAREN':
      case 'PIPE':
      case 'AND':
      case 'OR':
      case 'SEMI':
      case 'AMP':
      case 'GT':
      case 'GTGT':
      case 'LT':
      case 'LTGT':
      case 'DUP_OUT':
      case 'DUP_IN':
      case 'RPAREN':
      case 'HEREDOC':
      case 'HERESTRING':
      case 'PROC_SUB_IN':
      case 'PROC_SUB_OUT':
      case 'EOF':
        return undefined;
      default: {
        const _ex: never = peekType;
        throw new Error(`Unhandled token type: ${_ex}`);
      }
      }
      return undefined;
    }
    default:
      return undefined;
    }
  }

  private parseTrailingCompoundRedirections({
    node,
  }: {
    node: WeshASTNode;
  }): WeshASTNode {
    const redirections: WeshRedirection[] = [];
    while (this.isRedirectionStart()) {
      redirections.push(this.parseRedirection());
    }
    if (redirections.length === 0) {
      return node;
    }
    return {
      kind: 'redirected',
      node,
      redirections,
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
    case 'while':
    case 'until':
    case 'case':
    case 'functionDefinition':
    case 'arithmeticCommand':
    case 'redirected':
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

  private parseArithmeticCommand(): WeshASTNode {
    this.eat('DLPAREN');
    const parts: string[] = [];
    let depth = 1;

    while (true) {
      const token = this.currentToken;
      switch (token.type) {
      case 'LPAREN':
        depth += 1;
        parts.push(token.value);
        this.eat('LPAREN');
        break;
      case 'RPAREN': {
        const nextToken = this.lexer.peek();
        if (depth === 1 && nextToken.type === 'RPAREN') {
          this.eat('RPAREN');
          this.eat('RPAREN');
          return {
            kind: 'arithmeticCommand',
            expression: parts.join(' ').trim(),
          };
        }
        depth -= 1;
        parts.push(token.value);
        this.eat('RPAREN');
        break;
      }
      case 'EOF':
        throw new Error("Expected '))' to close arithmetic command");
      default:
        parts.push(token.value);
        this.eat(token.type);
        break;
      }
    }
  }

  private parseExtendedTestCommand(): WeshASTNode {
    this.eat('WORD');
    const args: string[] = [];

    while (true) {
      const token = this.currentToken;
      switch (token.type) {
      case 'WORD':
        args.push(token.value);
        this.eat('WORD');
        if (token.value === ']]') {
          return {
            kind: 'command',
            name: '[[',
            args,
            assignments: [],
            redirections: [],
          };
        }
        break;
      case 'AND':
        args.push('&&');
        this.eat('AND');
        break;
      case 'OR':
        args.push('||');
        this.eat('OR');
        break;
      case 'LPAREN':
        args.push('(');
        this.eat('LPAREN');
        break;
      case 'RPAREN':
        args.push(')');
        this.eat('RPAREN');
        break;
      case 'GT':
        args.push('>');
        this.eat('GT');
        break;
      case 'LT':
        args.push('<');
        this.eat('LT');
        break;
      case 'EOF':
        throw new Error("Expected closing ']]'");
      default:
        throw new Error(`Unexpected token in [[ expression: ${token.value}`);
      }
    }
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

    // Ensure the semicolon is handled as a separator
    // @ts-expect-error: The parser needs to handle cases where an optional semicolon separates the list of items from the do keyword.
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

  private parseWhile(): WeshASTNode {
    this.eat('WORD');
    const condition = this.parseList(['do']);
    this.expectKeyword({ keyword: 'do' });
    const body = this.parseList(['done']);
    this.expectKeyword({ keyword: 'done' });
    return {
      kind: 'while',
      condition,
      body,
    };
  }

  private parseUntil(): WeshASTNode {
    this.eat('WORD');
    const condition = this.parseList(['do']);
    this.expectKeyword({ keyword: 'do' });
    const body = this.parseList(['done']);
    this.expectKeyword({ keyword: 'done' });
    return {
      kind: 'until',
      condition,
      body,
    };
  }

  private parseFunctionDefinition({
    usedFunctionKeyword,
  }: {
    usedFunctionKeyword: boolean;
  }): WeshASTNode {
    if (usedFunctionKeyword) {
      this.eat('WORD');
    }

    const name = this.expectWord();
    switch (this.currentToken.type) {
    case 'LPAREN':
      this.eat('LPAREN');
      this.eat('RPAREN');
      break;
    case 'WORD':
    case 'DLPAREN':
    case 'PIPE':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'DUP_OUT':
    case 'DUP_IN':
    case 'RPAREN':
    case 'HEREDOC':
    case 'HERESTRING':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
    case 'EOF':
      break;
    default: {
      const _ex: never = this.currentToken.type;
      throw new Error(`Unhandled token type: ${_ex}`);
    }
    }

    this.expectKeyword({ keyword: '{' });

    const body = this.parseList(['}']);
    this.expectKeyword({ keyword: '}' });

    return {
      kind: 'functionDefinition',
      name,
      body,
    };
  }

  private parseCase(): WeshASTNode {
    this.eat('WORD');
    const word = this.expectWord();
    this.expectKeyword({ keyword: 'in' });

    const clauses: WeshCaseClause[] = [];
    while (true) {
      if (this.currentToken.type === 'WORD' && this.currentToken.value === 'esac') {
        break;
      }
      switch (this.currentToken.type) {
      case 'SEMI':
        this.eat('SEMI');
        continue;
      case 'WORD':
      case 'DLPAREN':
      case 'PIPE':
      case 'AND':
      case 'OR':
      case 'AMP':
      case 'GT':
      case 'GTGT':
      case 'LT':
      case 'LTGT':
      case 'DUP_OUT':
      case 'DUP_IN':
      case 'LPAREN':
      case 'RPAREN':
      case 'HEREDOC':
      case 'HERESTRING':
      case 'PROC_SUB_IN':
      case 'PROC_SUB_OUT':
      case 'EOF':
        break;
      default: {
        const _ex: never = this.currentToken.type;
        throw new Error(`Unhandled token type: ${_ex}`);
      }
      }
      clauses.push(this.parseCaseClause());
    }
    this.eat('WORD');

    return {
      kind: 'case',
      word,
      clauses,
    };
  }

  private parseCaseClause(): WeshCaseClause {
    const patterns: string[] = [];
    while (true) {
      patterns.push(this.expectWord());
      switch (this.currentToken.type) {
      case 'PIPE':
        this.eat('PIPE');
        continue;
      case 'WORD':
      case 'DLPAREN':
      case 'AND':
      case 'OR':
      case 'SEMI':
      case 'AMP':
      case 'GT':
      case 'GTGT':
      case 'LT':
      case 'LTGT':
      case 'DUP_OUT':
      case 'DUP_IN':
      case 'LPAREN':
      case 'RPAREN':
      case 'HEREDOC':
      case 'HERESTRING':
      case 'PROC_SUB_IN':
      case 'PROC_SUB_OUT':
      case 'EOF':
        break;
      default: {
        const _ex: never = this.currentToken.type;
        throw new Error(`Unhandled token type: ${_ex}`);
      }
      }
      break;
    }

    switch (this.currentToken.type) {
    case 'RPAREN':
      break;
    case 'WORD':
    case 'DLPAREN':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'DUP_OUT':
    case 'DUP_IN':
    case 'LPAREN':
    case 'HEREDOC':
    case 'HERESTRING':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
    case 'EOF':
      throw new Error("Expected ')' after case pattern");
    default: {
      const _ex: never = this.currentToken.type;
      throw new Error(`Unhandled token type: ${_ex}`);
    }
    }
    this.eat('RPAREN');

    const body = this.parseCaseClauseBody();

    if (this.startsWithDoubleSemicolon()) {
      this.eat('SEMI');
      this.eat('SEMI');
    }

    return {
      patterns,
      body,
    };
  }

  private parseCaseClauseBody(): WeshASTNode {
    while (this.currentToken.type === 'SEMI' && !this.isCaseClauseTerminator()) {
      this.eat('SEMI');
    }
    if (this.isCaseClauseTerminator()) {
      return {
        kind: 'list',
        parts: [],
      };
    }

    let node = this.parsePipeline(['esac']);

    while (!this.isCaseClauseTerminator()) {
      const type = this.currentToken.type;
      if (
        type !== 'SEMI' &&
        type !== 'AND' &&
        type !== 'OR' &&
        type !== 'AMP'
      ) {
        break;
      }

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
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled operator type: ${_ex}`);
      }
      }

      this.eat(type);
      if (this.isCaseClauseTerminator()) {
        const kind = node.kind;
        switch (kind) {
        case 'list': {
          const lastPart = node.parts[node.parts.length - 1];
          if (lastPart !== undefined) {
            lastPart.operator = operator;
          }
          return node;
        }
        case 'command':
        case 'pipeline':
        case 'if':
        case 'for':
        case 'while':
        case 'until':
        case 'case':
        case 'functionDefinition':
        case 'arithmeticCommand':
        case 'redirected':
        case 'assignment':
        case 'subshell':
          return {
            kind: 'list',
            parts: [{ node, operator }],
          };
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled node kind: ${_ex}`);
        }
        }
      }

      const nextNode = this.parsePipeline(['esac']);
      const kind = node.kind;
      switch (kind) {
      case 'list': {
        const lastPart = node.parts[node.parts.length - 1];
        if (lastPart !== undefined) {
          lastPart.operator = operator;
        }
        node.parts.push({ node: nextNode, operator: ';' });
        break;
      }
      case 'command':
      case 'pipeline':
      case 'if':
      case 'for':
      case 'while':
      case 'until':
      case 'case':
      case 'functionDefinition':
      case 'arithmeticCommand':
      case 'redirected':
      case 'assignment':
      case 'subshell':
        node = {
          kind: 'list',
          parts: [
            { node, operator },
            { node: nextNode, operator: ';' },
          ],
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

  private isCaseClauseTerminator(): boolean {
    if (this.currentToken.type === 'WORD' && this.currentToken.value === 'esac') {
      return true;
    }
    return this.currentToken.type === 'SEMI' && this.lexer.peek().type === 'SEMI';
  }

  private startsWithDoubleSemicolon(): boolean {
    return this.currentToken.type === 'SEMI' && this.lexer.peek().type === 'SEMI';
  }

  private expectWord(): string {
    const type = this.currentToken.type;
    switch (type) {
    case 'WORD': {
      const val = this.currentToken.value;
      this.eat('WORD');
      return val;
    }
    case 'LPAREN':
    case 'RPAREN':
    case 'PIPE':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'DUP_OUT':
    case 'DUP_IN':
    case 'HEREDOC':
    case 'HERESTRING':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
    case 'DLPAREN':
    case 'EOF':
      throw new Error(`Expected word, got: ${type}`);
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled token type: ${_ex}`);
    }
    }
  }

  private expectKeyword({
    keyword,
  }: {
    keyword: string;
  }): void {
    if (this.currentToken.type !== 'WORD' || this.currentToken.value !== keyword) {
      throw new Error(`Expected '${keyword}'`);
    }
    this.eat('WORD');
  }

  private isRedirectionStart(): boolean {
    if (this.isRedirection(this.currentToken.type)) {
      return true;
    }

    switch (this.currentToken.type) {
    case 'WORD':
      break;
    case 'PIPE':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'DUP_OUT':
    case 'DUP_IN':
    case 'LPAREN':
    case 'RPAREN':
    case 'HEREDOC':
    case 'HERESTRING':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
    case 'DLPAREN':
    case 'EOF':
      return false;
    default: {
      const _ex: never = this.currentToken.type;
      throw new Error(`Unhandled token type: ${_ex}`);
    }
    }

    if (!/^\d+$/.test(this.currentToken.value)) {
      return false;
    }

    return this.isRedirection(this.lexer.peek().type);
  }

  private parseRedirection(): WeshRedirection {
    let explicitFd: number | undefined;
    if (this.currentToken.type === 'WORD' && /^\d+$/.test(this.currentToken.value)) {
      explicitFd = parseInt(this.currentToken.value, 10);
      this.eat('WORD');
    }

    const tokenType = this.currentToken.type;
    this.eat(tokenType);
    const fd = explicitFd ?? (() => {
      switch (tokenType) {
      case 'LT':
      case 'LTGT':
      case 'DUP_IN':
      case 'HEREDOC':
      case 'HERESTRING':
        return 0;
      case 'GT':
      case 'GTGT':
      case 'DUP_OUT':
        return 1;
      case 'WORD':
      case 'PIPE':
      case 'AND':
      case 'OR':
      case 'SEMI':
      case 'AMP':
      case 'LPAREN':
      case 'RPAREN':
      case 'PROC_SUB_IN':
      case 'PROC_SUB_OUT':
      case 'DLPAREN':
      case 'EOF':
        throw new Error(`Unexpected redirection token: ${tokenType}`);
      default: {
        const _ex: never = tokenType;
        throw new Error(`Unhandled redirection token: ${_ex}`);
      }
      }
    })();

    switch (tokenType) {
    case 'GT':
      return { fd, type: 'write', target: this.expectWord() };
    case 'GTGT':
      return { fd, type: 'append', target: this.expectWord() };
    case 'LT': {
      const target = this.currentToken.type === 'PROC_SUB_IN' || this.currentToken.type === 'PROC_SUB_OUT'
        ? this.parseProcessSubstitution({
          tokenType: this.currentToken.type as 'PROC_SUB_IN' | 'PROC_SUB_OUT',
        })
        : this.expectWord();
      return { fd, type: 'read', target };
    }
    case 'LTGT': {
      const target = this.currentToken.type === 'PROC_SUB_IN' || this.currentToken.type === 'PROC_SUB_OUT'
        ? this.parseProcessSubstitution({
          tokenType: this.currentToken.type as 'PROC_SUB_IN' | 'PROC_SUB_OUT',
        })
        : this.expectWord();
      return { fd, type: 'read-write', target };
    }
    case 'DUP_OUT':
    case 'DUP_IN': {
      const target = this.expectWord();
      const redirectionType = (() => {
        switch (tokenType) {
        case 'DUP_OUT':
          return 'dup-output' as const;
        case 'DUP_IN':
          return 'dup-input' as const;
        default: {
          const _ex: never = tokenType;
          throw new Error(`Unhandled redirection token: ${_ex}`);
        }
        }
      })();

      if (target === '-') {
        return {
          fd,
          type: redirectionType,
          target,
          closeTarget: true,
        };
      }

      if (!/^\d+$/.test(target)) {
        const operatorText = (() => {
          switch (tokenType) {
          case 'DUP_OUT':
            return '>&';
          case 'DUP_IN':
            return '<&';
          default: {
            const _ex: never = tokenType;
            throw new Error(`Unhandled redirection token: ${_ex}`);
          }
          }
        })();
        throw new Error(`Expected file descriptor after ${operatorText}`);
      }

      return {
        fd,
        type: redirectionType,
        target,
        targetFd: parseInt(target, 10),
      };
    }
    case 'HERESTRING': {
      const target = this.expectWord();
      return { fd, type: 'herestring', target, content: target };
    }
    case 'HEREDOC': {
      const rawTarget = this.expectWord();
      const { delimiter, contentExpansion } = parseHereDocDelimiter({ raw: rawTarget });
      return {
        fd,
        type: 'heredoc',
        target: delimiter,
        content: this.lexer.readHereDoc(delimiter),
        contentExpansion,
      };
    }
    case 'WORD':
    case 'PIPE':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'LPAREN':
    case 'RPAREN':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
    case 'DLPAREN':
    case 'EOF':
      throw new Error(`Unexpected redirection token: ${tokenType}`);
    default: {
      const _ex: never = tokenType;
      throw new Error(`Unhandled redirection token: ${_ex}`);
    }
    }
  }

  private isRedirection(type: TokenType): boolean {
    switch (type) {
    case 'GT':
    case 'GTGT':
    case 'LT':
    case 'LTGT':
    case 'DUP_OUT':
    case 'DUP_IN':
    case 'HEREDOC':
    case 'HERESTRING':
      return true;
    case 'WORD':
    case 'PIPE':
    case 'AND':
    case 'OR':
    case 'SEMI':
    case 'AMP':
    case 'LPAREN':
    case 'RPAREN':
    case 'PROC_SUB_IN':
    case 'PROC_SUB_OUT':
    case 'DLPAREN':
    case 'EOF':
      return false;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled token type: ${_ex}`);
    }
    }
  }
}
