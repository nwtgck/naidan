import { Lexer, ShellLexerIncompleteError } from './lexer';
import type { ConditionalTokenContext, Token, TokenType } from './lexer';
import { parseShellHereDocumentDelimiter } from './shell/scan';
import type {
  WeshASTNode,
  WeshCaseClause,
  WeshConditionalBinaryOperator,
  WeshConditionalExpression,
  WeshConditionalOperand,
  WeshConditionalUnaryOperator,
  WeshListNode,
  WeshRedirection,
  WeshSubshellNode,
  WeshProcessSubstitutionNode,
} from './types';

export function parseCommandLine({
  commandLine,
}: {
  commandLine: string,
}): WeshASTNode {
  const lexer = new Lexer({ input: commandLine });
  const parser = new Parser({ lexer, sourceCompletion: 'complete' });
  return parser.parse();
}

export type ShellUnitParseResult =
  | {
      kind: 'parsed',
      node: WeshASTNode,
      consumedCharacters: number,
      warnings?: string[],
    }
  | {
      kind: 'needs-more-source',
    };

export function parseNextShellUnit({
  commandLine,
  sourceCompletion,
}: {
  commandLine: string,
  sourceCompletion: 'complete' | 'may-continue',
}): ShellUnitParseResult {
  const lexer = new Lexer({ input: commandLine });
  let parser: Parser | undefined;

  try {
    parser = new Parser({ lexer, sourceCompletion });
    const { node, boundary } = parser.parseNextUnit();

    switch (boundary.kind) {
    case 'eof':
      switch (sourceCompletion) {
      case 'complete':
        return {
          kind: 'parsed',
          node,
          consumedCharacters: boundary.consumedCharacters,
          ...(parser.warnings.length > 0 ? { warnings: parser.warnings } : {}),
        };
      case 'may-continue':
        return { kind: 'needs-more-source' };
      default: {
        const _ex: never = sourceCompletion;
        throw new Error(`Unhandled shell source completion: ${_ex}`);
      }
      }
    case 'newline': {
      return {
        kind: 'parsed',
        node,
        consumedCharacters: boundary.consumedCharacters,
        ...(parser.warnings.length > 0 ? { warnings: parser.warnings } : {}),
      };
    }
    default: {
      const _ex: never = boundary;
      throw new Error(`Unhandled shell unit boundary: ${JSON.stringify(_ex)}`);
    }
    }
  } catch (error: unknown) {
    const sourceCanContinue = (() => {
      switch (sourceCompletion) {
      case 'complete':
        return false;
      case 'may-continue':
        return true;
      default: {
        const _ex: never = sourceCompletion;
        throw new Error(`Unhandled shell source completion: ${_ex}`);
      }
      }
    })();
    if (
      sourceCanContinue &&
      (
        error instanceof ShellLexerIncompleteError ||
        parser?.isAtEndOfInput() === true
      )
    ) {
      return { kind: 'needs-more-source' };
    }
    throw error;
  }
}

const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'in', 'do', 'done',
  'while', 'until',
  'case', 'esac',
  'function',
]);

const MAX_CONDITIONAL_DEPTH = 512;

const conditionalUnaryOperators: ReadonlySet<string> = new Set<WeshConditionalUnaryOperator>([
  '-n', '-z', '-v',
  '-b', '-c', '-d', '-e', '-f', '-h', '-L',
  '-p', '-r', '-s', '-S', '-t', '-w', '-x',
]);
const conditionalBinaryOperators: ReadonlySet<string> = new Set<WeshConditionalBinaryOperator>([
  '=', '==', '!=', '=~', '<', '>',
  '-eq', '-ne', '-lt', '-le', '-gt', '-ge',
  '-ef', '-nt', '-ot',
]);

function isConditionalUnaryOperator(value: string): value is WeshConditionalUnaryOperator {
  return conditionalUnaryOperators.has(value);
}

function isConditionalBinaryOperator(value: string): value is WeshConditionalBinaryOperator {
  return conditionalBinaryOperators.has(value);
}

class Parser {
  private currentToken: Token;
  private lexer: Lexer;
  private sourceCompletion: 'complete' | 'may-continue';
  readonly warnings: string[] = [];
  private pendingHereDocuments: {
    redirection: WeshRedirection,
    delimiter: string,
    tabHandling: 'preserve' | 'strip-leading',
    contentExpansion: 'literal' | 'variables',
  }[] = [];

  constructor({ lexer, sourceCompletion }: {
    lexer: Lexer,
    sourceCompletion: 'complete' | 'may-continue',
  }) {
    this.lexer = lexer;
    this.sourceCompletion = sourceCompletion;
    this.currentToken = this.lexer.next();
  }

  isAtEndOfInput(): boolean {
    return this.currentToken.type === 'EOF';
  }

  private eat({ type }: { type: TokenType }) {
    if (this.currentToken.type === type) {
      if (type === 'SEMI' && this.currentToken.value === '\n') {
        this.readPendingHereDocuments();
      }
      this.currentToken = this.lexer.next();
    } else {
      throw new Error(`Unexpected token: ${this.currentToken.value}, expected ${type}`);
    }
  }

  private readPendingHereDocuments(): void {
    // Bodies start after the complete command-line newline. All heredocs on
    // the line are consumed in declaration order, not at each << operator.
    const pending = this.pendingHereDocuments;
    this.pendingHereDocuments = [];
    for (const { redirection, delimiter, tabHandling, contentExpansion } of pending) {
      const result = this.lexer.readHereDoc({
        delimiter,
        tabHandling,
        contentExpansion,
        sourceCompletion: this.sourceCompletion,
      });
      redirection.content = result.content;
      if (!result.terminated) {
        this.warnings.push(`here-document delimited by end-of-file (wanted \`${delimiter}')`);
      }
    }
  }

  private parseProcessSubstitution({
    tokenType,
    followingContext,
  }: {
    tokenType: 'PROC_SUB_IN' | 'PROC_SUB_OUT',
    followingContext?: 'conditional',
  }): WeshProcessSubstitutionNode {
    this.eat({ type: tokenType });

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

    const list = this.parseList({ terminators: ['RPAREN'], newlinePolicy: 'separator' });

    const endType = this.currentToken.type;
    switch (endType) {
    case 'RPAREN': {
      if (followingContext === undefined) {
        this.eat({ type: 'RPAREN' });
        break;
      }
      const endPosition = this.currentToken.position + 1;
      this.currentToken = this.lexer.next({ context: followingContext });
      if (this.currentToken.type === 'WORD' && this.lexer.isAdjacentWord({ end: endPosition, start: this.currentToken.position })) {
        throw new Error('Expected a word boundary after conditional process substitution');
      }
      break;
    }
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
    const node = this.parseList({
      terminators: [],
      newlinePolicy: 'separator',
    });
    if (this.pendingHereDocuments.length > 0) {
      this.readPendingHereDocuments();
    }
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

  parseNextUnit(): {
    node: WeshASTNode,
    boundary: { kind: 'newline', consumedCharacters: number } | { kind: 'eof', consumedCharacters: number },
    } {
    const node = this.parseList({
      terminators: [],
      newlinePolicy: 'unit-boundary',
    });

    if (this.currentToken.type === 'SEMI' && this.currentToken.value === '\n') {
      this.readPendingHereDocuments();
    } else if (this.pendingHereDocuments.length > 0) {
      this.readPendingHereDocuments();
    }

    switch (this.currentToken.type) {
    case 'SEMI':
      if (this.currentToken.value !== '\n') {
        throw new Error(`Unexpected separator at shell unit boundary: ${this.currentToken.value}`);
      }
      return {
        node,
        boundary: {
          kind: 'newline',
          consumedCharacters: this.lexer.getPosition(),
        },
      };
    case 'EOF':
      return {
        node,
        boundary: {
          kind: 'eof',
          consumedCharacters: this.lexer.getPosition(),
        },
      };
    case 'WORD':
    case 'PIPE':
    case 'AND':
    case 'OR':
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
      throw new Error(`Unexpected token at shell unit boundary: ${this.currentToken.value}`);
    default: {
      const _ex: never = this.currentToken.type;
      throw new Error(`Unhandled token type: ${_ex}`);
    }
    }
  }

  private parseList({
    terminators,
    newlinePolicy,
  }: {
    terminators: string[],
    newlinePolicy: 'separator' | 'unit-boundary',
  }): WeshASTNode {
    while (this.currentToken.type === 'SEMI' && !this.isTerminator({ terminators })) {
      if (newlinePolicy === 'unit-boundary' && this.currentToken.value === '\n') {
        return {
          kind: 'list',
          parts: [],
        };
      }
      this.eat({ type: 'SEMI' });
    }

    if (this.isTerminator({ terminators }) || this.currentToken.type === 'EOF') {
      return {
        kind: 'list',
        parts: [],
      };
    }

    let node = this.parsePipeline({ terminators });
    let parts: WeshListNode['parts'] | undefined;

    while (
      (this.currentToken.type === 'SEMI' ||
      this.currentToken.type === 'AND' ||
      this.currentToken.type === 'OR' ||
      this.currentToken.type === 'AMP') &&
      !this.isTerminator({ terminators })
    ) {
      if (
        newlinePolicy === 'unit-boundary' &&
        this.currentToken.type === 'SEMI' &&
        this.currentToken.value === '\n'
      ) {
        break;
      }

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

      parts ??= [];
      parts.push({ node, operator });
      this.eat({ type });
      while (this.currentToken.type === 'SEMI' && !this.isTerminator({ terminators })) {
        if (
          newlinePolicy === 'unit-boundary' &&
          this.currentToken.value === '\n' &&
          type !== 'AND' &&
          type !== 'OR'
        ) {
          return { kind: 'list', parts };
        }
        this.eat({ type: 'SEMI' });
      }

      if (this.isTerminator({ terminators }) || (this.currentToken.type as TokenType) === 'EOF') {
        if (type === 'AND' || type === 'OR') {
          throw new Error(`Expected command after '${operator}'`);
        }
        return { kind: 'list', parts };
      }

      node = this.parsePipeline({ terminators });
    }

    if (parts === undefined) {
      return node;
    }
    parts.push({ node, operator: ';' });
    return { kind: 'list', parts };
  }

  private isTerminator({ terminators }: { terminators: string[] }): boolean {
    return (this.currentToken.type === 'WORD' && terminators.includes(this.currentToken.value)) ||
           this.currentToken.type === 'RPAREN';
  }

  private parsePipeline({ terminators }: { terminators: string[] }): WeshASTNode {
    const first = this.parseCommand({ terminators });
    const commands: WeshASTNode[] = [first];
    let stage = first;

    while (this.currentToken.type === 'PIPE' && !this.isTerminator({ terminators })) {
      this.eat({ type: 'PIPE' });
      const pipeStderr = (this.currentToken.type as TokenType) === 'AMP';
      if (pipeStderr) {
        this.eat({ type: 'AMP' });
        const kind = stage.kind;
        const redirection: WeshRedirection = {
          fd: 2,
          type: 'dup_output',
          target: '1',
          targetFd: 1,
        };
        switch (kind) {
        case 'command':
        case 'redirected':
          stage.redirections.push(redirection);
          break;
        case 'pipeline':
        case 'list':
        case 'if':
        case 'for':
        case 'while':
        case 'until':
        case 'case':
        case 'functionDefinition':
        case 'arithmeticCommand':
        case 'conditionalCommand':
        case 'assignment':
        case 'subshell':
          stage = { kind: 'redirected', node: stage, redirections: [redirection] };
          commands[commands.length - 1] = stage;
          break;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled pipeline node kind: ${_ex}`);
        }
        }
      }
      while ((this.currentToken.type as TokenType) === 'SEMI' && this.currentToken.value === '\n') {
        this.eat({ type: 'SEMI' });
      }
      if (this.isTerminator({ terminators }) || (this.currentToken.type as TokenType) === 'EOF') {
        throw new Error("Expected command after pipe");
      }
      stage = this.parseCommand({ terminators });
      commands.push(stage);
    }

    return commands.length === 1 ? first : { kind: 'pipeline', commands };
  }

  private parseCommand({ terminators = [] }: { terminators?: string[] } = {}): WeshASTNode {
    if (this.isTerminator({ terminators })) {
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

    const assignments: { key: string, value: string }[] = [];
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
      ) && !this.isTerminator({ terminators });
    };

    while (canContinue()) {
      const t = this.currentToken.type;
      if (this.isRedirectionStart()) {
        redirections.push(...this.parseRedirectionGroup());

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

          this.eat({ type: 'WORD' });

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

    if (commandName === null && redirections.length > 0) {
      return {
        kind: 'redirected',
        node: { kind: 'list', parts: [] },
        redirections,
      };
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
      redirections,
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
      if (val === '{') {
        return this.parseBraceGroup();
      }
      if (val === 'if') {
        return this.parseIf();
      }
      if (val === 'for') {
        return this.parseFor();
      }
      if (val === 'while') {
        return this.parseWhile();
      }
      if (val === 'until') {
        return this.parseUntil();
      }
      if (val === 'case') {
        return this.parseCase();
      }
      if (val === 'function') {
        return this.parseFunctionDefinition({ usedFunctionKeyword: true });
      }
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
    node: WeshASTNode,
  }): WeshASTNode {
    const redirections: WeshRedirection[] = [];
    while (this.isRedirectionStart()) {
      redirections.push(...this.parseRedirectionGroup());
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

  private parseBraceGroup(): WeshASTNode {
    this.expectKeyword({ keyword: '{' });
    const body = this.parseList({
      terminators: ['}'],
      newlinePolicy: 'separator',
    });
    this.expectKeyword({ keyword: '}' });
    return body;
  }

  private parseSubshell(): WeshSubshellNode {
    this.eat({ type: 'LPAREN' });
    const list = this.parseList({ terminators: [], newlinePolicy: 'separator' });

    switch (this.currentToken.type) {
    case 'RPAREN':
      break;
    default:
      throw new Error(`Expected ')', got: ${this.currentToken.value}`);
    }

    this.eat({ type: 'RPAREN' });

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
    case 'conditionalCommand':
    case 'redirected':
    case 'assignment':
    case 'subshell':
      listNode = {
        kind: 'list',
        parts: [{ node: list, operator: ';' }],
      };
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled node kind: ${_ex}`);
    }
    }

    return {
      kind: 'subshell',
      list: listNode,
    };
  }

  private parseArithmeticCommand(): WeshASTNode {
    const expression = this.lexer.readArithmeticCommand({ startIndex: this.currentToken.position });
    this.currentToken = this.lexer.next();
    return { kind: 'arithmeticCommand', expression };
  }

  private parseExtendedTestCommand(): WeshASTNode {
    this.currentToken = this.lexer.next({ context: 'conditional-term' });
    const expression = this.parseConditionalOr({ depth: 0 });
    if (this.getConditionalWord() !== ']]') {
      this.failConditionalSyntax({ message: "Expected closing ']]' after conditional expression" });
    }
    this.currentToken = this.lexer.next();
    return { kind: 'conditionalCommand', expression };
  }

  private parseConditionalOr({ depth }: { depth: number }): WeshConditionalExpression {
    const first = this.parseConditionalAnd({ depth });
    let operands: WeshConditionalExpression[] | undefined;
    while (this.currentToken.value === '||') {
      operands ??= [first];
      this.currentToken = this.lexer.next({ context: 'conditional-term' });
      operands.push(this.parseConditionalAnd({ depth }));
    }
    return operands === undefined ? first : { kind: 'or', operands };
  }

  private parseConditionalAnd({ depth }: { depth: number }): WeshConditionalExpression {
    const first = this.parseConditionalTerm({ depth });
    this.skipConditionalNewlines({ context: 'conditional' });
    let operands: WeshConditionalExpression[] | undefined;
    while (this.currentToken.value === '&&') {
      operands ??= [first];
      this.currentToken = this.lexer.next({ context: 'conditional-term' });
      operands.push(this.parseConditionalTerm({ depth }));
      this.skipConditionalNewlines({ context: 'conditional' });
    }
    return operands === undefined ? first : { kind: 'and', operands };
  }

  private parseConditionalTerm({ depth }: { depth: number }): WeshConditionalExpression {
    if (depth >= MAX_CONDITIONAL_DEPTH) {
      throw new Error('Conditional expression nesting limit exceeded');
    }
    this.skipConditionalNewlines({ context: 'conditional-term' });
    if (this.currentToken.value === '(') {
      this.currentToken = this.lexer.next({ context: 'conditional-term' });
      const expression = this.parseConditionalOr({ depth: depth + 1 });
      if (this.currentToken.value !== ')') {
        this.failConditionalSyntax({ message: "Expected ')' after conditional expression" });
      }
      this.currentToken = this.lexer.next({ context: 'conditional' });
      return expression;
    }
    const operatorOrWord = this.getConditionalWord();
    if (operatorOrWord === '!') {
      this.currentToken = this.lexer.next({ context: 'conditional-term' });
      return { kind: 'not', operand: this.parseConditionalTerm({ depth: depth + 1 }) };
    }
    if (isConditionalUnaryOperator(operatorOrWord)) {
      this.currentToken = this.lexer.next({ context: 'conditional' });
      return { kind: 'unary', operator: operatorOrWord, word: this.takeConditionalOperand() };
    }

    const left = this.takeConditionalOperand();
    const operator = this.getConditionalWord();
    const context = operator === '=~' ? 'conditional-regexp' : 'conditional';
    if (isConditionalBinaryOperator(operator)) {
      this.currentToken = this.lexer.next({ context });
      return { kind: 'binary', operator, left, right: this.takeConditionalOperand() };
    }
    if (operator === ']]' || operator === ')' || operator === '&&' || operator === '||') {
      return { kind: 'word', word: left };
    }
    this.failConditionalSyntax({ message: 'Expected a conditional binary operator' });
  }

  private getConditionalWord(): string {
    return this.currentToken.value.replaceAll('\\\n', '');
  }

  private takeConditionalOperand(): WeshConditionalOperand {
    const { type, value } = this.currentToken;
    if (type === 'PROC_SUB_IN' || type === 'PROC_SUB_OUT') {
      return this.parseProcessSubstitution({ tokenType: type, followingContext: 'conditional' });
    }
    if ((value === '<' || value === '>') && this.sourceCompletion === 'may-continue' && this.lexer.isAtEndOfInput()) {
      throw new ShellLexerIncompleteError('Incomplete conditional process substitution');
    }
    if (type !== 'WORD' || this.getConditionalWord() === ']]') {
      this.failConditionalSyntax({ message: 'Expected a conditional operand' });
    }
    this.currentToken = this.lexer.next({ context: 'conditional' });
    return value;
  }

  private skipConditionalNewlines({ context }: { context: ConditionalTokenContext }): void {
    while (this.currentToken.type === 'SEMI' && this.currentToken.value === '\n') {
      this.readPendingHereDocuments();
      this.currentToken = this.lexer.next({ context });
    }
  }

  private failConditionalSyntax({ message }: { message: string }): never {
    const token = this.currentToken;
    if (this.sourceCompletion === 'may-continue' && this.lexer.isAtEndOfInput()
      && (token.type === 'WORD' || token.type === 'PIPE' || token.type === 'AMP')) {
      throw new ShellLexerIncompleteError(message);
    }
    throw new Error(message);
  }

  private parseIf(): WeshASTNode {
    this.eat({ type: 'WORD' }); // eat 'if'
    const condition = this.parseList({ terminators: ['then'], newlinePolicy: 'separator' });

    if (this.currentToken.type !== 'WORD' || (this.currentToken.value as string) !== 'then') {
      throw new Error("Expected 'then'");
    }
    this.eat({ type: 'WORD' }); // eat 'then'

    const thenBody = this.parseList({ terminators: ['else', 'elif', 'fi'], newlinePolicy: 'separator' });

    let elseBody: WeshASTNode | undefined;
    if (this.currentToken.type === 'WORD' && (this.currentToken.value as string) === 'else') {
      this.eat({ type: 'WORD' });
      elseBody = this.parseList({ terminators: ['fi'], newlinePolicy: 'separator' });
    } else if (this.currentToken.type === 'WORD' && (this.currentToken.value as string) === 'elif') {
      this.currentToken.value = 'if';
      elseBody = this.parseIf();
      return {
        kind: 'if',
        condition,
        thenBody,
        elseBody,
      };
    }

    if (this.currentToken.type !== 'WORD' || (this.currentToken.value as string) !== 'fi') {
      throw new Error("Expected 'fi'");
    }
    this.eat({ type: 'WORD' });

    return {
      kind: 'if',
      condition,
      thenBody,
      elseBody,
    };
  }

  private parseFor(): WeshASTNode {
    this.eat({ type: 'WORD' }); // eat 'for'

    switch (this.currentToken.type) {
    case 'WORD':
      break;
    default:
      throw new Error("Expected variable name");
    }
    const variable = this.currentToken.value;
    this.eat({ type: 'WORD' });

    const items: string[] = [];
    const hasImplicitItems = (() => {
      switch (this.currentToken.type as TokenType) {
      case 'SEMI':
        return true;
      default:
        return false;
      }
    })();
    if (hasImplicitItems) {
      items.push('"$@"');
      this.eat({ type: 'SEMI' });
    } else {
      switch (this.currentToken.type) {
      case 'WORD':
        if ((this.currentToken.value as string) !== 'in') {
          throw new Error("Expected 'in'");
        }
        break;
      default:
        throw new Error("Expected 'in'");
      }
      this.eat({ type: 'WORD' });

      while (this.currentToken.type === 'WORD' && (this.currentToken.value as string) !== 'do' && (this.currentToken.value as string) !== ';') {
        items.push(this.currentToken.value);
        this.eat({ type: 'WORD' });
      }

      // Ensure the semicolon is handled as a separator
      // @ts-expect-error: The parser needs to handle cases where an optional semicolon separates the list of items from the do keyword.
      if (this.currentToken.type === 'SEMI') {
        this.eat({ type: 'SEMI' });
      }
    }

    if (this.currentToken.type !== 'WORD' || (this.currentToken.value as string) !== 'do') {
      throw new Error("Expected 'do'");
    }
    this.eat({ type: 'WORD' });

    const body = this.parseList({ terminators: ['done'], newlinePolicy: 'separator' });

    if (this.currentToken.type !== 'WORD' || (this.currentToken.value as string) !== 'done') {
      throw new Error("Expected 'done'");
    }
    this.eat({ type: 'WORD' });

    return {
      kind: 'for',
      variable,
      items,
      body,
    };
  }

  private parseWhile(): WeshASTNode {
    this.eat({ type: 'WORD' });
    const condition = this.parseList({ terminators: ['do'], newlinePolicy: 'separator' });
    this.expectKeyword({ keyword: 'do' });
    const body = this.parseList({ terminators: ['done'], newlinePolicy: 'separator' });
    this.expectKeyword({ keyword: 'done' });
    return {
      kind: 'while',
      condition,
      body,
    };
  }

  private parseUntil(): WeshASTNode {
    this.eat({ type: 'WORD' });
    const condition = this.parseList({ terminators: ['do'], newlinePolicy: 'separator' });
    this.expectKeyword({ keyword: 'do' });
    const body = this.parseList({ terminators: ['done'], newlinePolicy: 'separator' });
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
    usedFunctionKeyword: boolean,
  }): WeshASTNode {
    if (usedFunctionKeyword) {
      this.eat({ type: 'WORD' });
    }

    const name = this.expectWord();
    switch (this.currentToken.type) {
    case 'LPAREN':
      this.eat({ type: 'LPAREN' });
      this.eat({ type: 'RPAREN' });
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

    const body = this.parseList({ terminators: ['}'], newlinePolicy: 'separator' });
    this.expectKeyword({ keyword: '}' });

    return {
      kind: 'functionDefinition',
      name,
      body,
    };
  }

  private parseCase(): WeshASTNode {
    this.eat({ type: 'WORD' });
    const word = this.expectWord();
    this.expectKeyword({ keyword: 'in' });

    const clauses: WeshCaseClause[] = [];
    while (true) {
      if (this.currentToken.type === 'WORD' && this.currentToken.value === 'esac') {
        break;
      }
      switch (this.currentToken.type) {
      case 'SEMI':
        this.eat({ type: 'SEMI' });
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
    this.eat({ type: 'WORD' });

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
        this.eat({ type: 'PIPE' });
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
    this.eat({ type: 'RPAREN' });

    const body = this.parseCaseClauseBody();

    if (this.startsWithDoubleSemicolon()) {
      this.eat({ type: 'SEMI' });
      this.eat({ type: 'SEMI' });
    }

    return {
      patterns,
      body,
    };
  }

  private parseCaseClauseBody(): WeshASTNode {
    while (this.currentToken.type === 'SEMI' && !this.isCaseClauseTerminator()) {
      this.eat({ type: 'SEMI' });
    }
    if (this.isCaseClauseTerminator()) {
      return {
        kind: 'list',
        parts: [],
      };
    }

    let node = this.parsePipeline({ terminators: ['esac'] });

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

      this.eat({ type });
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
        case 'conditionalCommand':
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

      const nextNode = this.parsePipeline({ terminators: ['esac'] });
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
      case 'conditionalCommand':
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
      this.eat({ type: 'WORD' });
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
    keyword: string,
  }): void {
    if (this.currentToken.type !== 'WORD' || this.currentToken.value !== keyword) {
      throw new Error(`Expected '${keyword}'`);
    }
    this.eat({ type: 'WORD' });
  }

  private isRedirectionStart(): boolean {
    if (this.isRedirection({ type: this.currentToken.type })) {
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

    const word = this.currentToken;
    if (!/^\d(?:\d|\\\n)*$/.test(word.value)) {
      return false;
    }
    const next = this.lexer.peek();
    if (next.position !== word.position + word.value.length) {
      return false;
    }
    if (next.type === 'EOF' && this.sourceCompletion === 'may-continue') {
      throw new ShellLexerIncompleteError('Incomplete numeric redirection prefix');
    }
    return next.value !== '&>' && next.value !== '&>>'
      && this.isRedirection({ type: next.type });
  }

  private parseRedirectionGroup(): WeshRedirection[] {
    let explicitFd: number | undefined;
    if (!this.isRedirection({ type: this.currentToken.type })) {
      explicitFd = Number.parseInt(this.currentToken.value.replaceAll('\\\n', ''), 10);
      this.eat({ type: 'WORD' });
    }
    const operatorValue = this.currentToken.value;
    const primary = this.parseRedirection({ explicitFd });
    if (operatorValue !== '&>' && operatorValue !== '&>>') {
      return [primary];
    }
    return [
      primary,
      {
        fd: 2,
        type: 'dup_output',
        target: '1',
        targetFd: 1,
      },
    ];
  }

  private parseRedirection({ explicitFd }: { explicitFd: number | undefined }): WeshRedirection {
    const tokenType = this.currentToken.type;
    const tokenValue = this.currentToken.value;
    this.eat({ type: tokenType });
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
    case 'GT': {
      const target = this.currentToken.type === 'PROC_SUB_IN' || this.currentToken.type === 'PROC_SUB_OUT'
        ? this.parseProcessSubstitution({
          tokenType: this.currentToken.type as 'PROC_SUB_IN' | 'PROC_SUB_OUT',
        })
        : this.expectWord();
      return { fd, type: 'write', target };
    }
    case 'GTGT': {
      const target = this.currentToken.type === 'PROC_SUB_IN' || this.currentToken.type === 'PROC_SUB_OUT'
        ? this.parseProcessSubstitution({
          tokenType: this.currentToken.type as 'PROC_SUB_IN' | 'PROC_SUB_OUT',
        })
        : this.expectWord();
      return { fd, type: 'append', target };
    }
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
      return { fd, type: 'read_write', target };
    }
    case 'DUP_OUT':
    case 'DUP_IN': {
      const target = this.expectWord();
      const redirectionType = (() => {
        switch (tokenType) {
        case 'DUP_OUT':
          return 'dup_output' as const;
        case 'DUP_IN':
          return 'dup_input' as const;
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
      const { delimiter, contentExpansion } = parseShellHereDocumentDelimiter({ raw: rawTarget });
      const tabHandling = (() => {
        switch (tokenValue) {
        case '<<':
          return 'preserve' as const;
        case '<<-':
          return 'strip-leading' as const;
        default:
          throw new Error(`Unexpected here-document operator: ${tokenValue}`);
        }
      })();
      const redirection: WeshRedirection = {
        fd,
        type: 'heredoc',
        target: delimiter,
        contentExpansion,
      };
      this.pendingHereDocuments.push({
        redirection,
        delimiter,
        tabHandling,
        contentExpansion,
      });
      return redirection;
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

  private isRedirection({ type }: { type: TokenType }): boolean {
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
