import { resolveCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { compileExtendedRegularExpression } from '@/features/wesh/commands/_shared/posix-regexp';
import type { WeshConditionalExpression, WeshConditionalOperand, WeshIVirtualFileSystem } from '@/features/wesh/types';
import { evaluateBinaryFileTest, evaluateUnaryFileTest } from './file-test';
import { matchesShellPattern } from './pattern';

export async function evaluateShellConditional({ expression, expand, evaluateNumber, getVariable, cwd, files, checkActive }: {
  expression: WeshConditionalExpression,
  expand: ({ operand, context }: { operand: WeshConditionalOperand, context: 'word' | 'pattern' | 'regex' }) => Promise<string>,
  evaluateNumber: ({ expression }: { expression: string }) => Promise<bigint | undefined>,
  getVariable: ({ name }: { name: string }) => string | undefined,
  cwd: string,
  files: Pick<WeshIVirtualFileSystem, 'stat' | 'resolveEntry' | 'compareEntryIdentity'>,
  checkActive: () => void,
}): Promise<0 | 1 | 2> {
  async function expandOperand({ operand, context }: { operand: WeshConditionalOperand, context: Parameters<typeof expand>[0]['context'] }): Promise<string> {
    const value = await expand({ operand, context });
    checkActive();
    return value;
  }

  async function evaluate({ node }: { node: WeshConditionalExpression }): Promise<0 | 1 | 2> {
    checkActive();
    switch (node.kind) {
    case 'and':
    case 'or': {
      const conjunction = node.kind === 'and';
      let status: 0 | 1 | 2 = conjunction ? 0 : 1;
      for (const operand of node.operands) {
        status = await evaluate({ node: operand });
        if (conjunction ? status !== 0 : status === 0) {
          break;
        }
      }
      return status;
    }
    case 'not':
      return await evaluate({ node: node.operand }) === 0 ? 1 : 0;
    case 'word':
      return (await expandOperand({ operand: node.word, context: 'word' })).length > 0 ? 0 : 1;
    case 'unary': {
      const operand = await expandOperand({ operand: node.word, context: 'word' });
      const { operator } = node;
      switch (operator) {
      case '-n':
        return operand.length > 0 ? 0 : 1;
      case '-z':
        return operand.length === 0 ? 0 : 1;
      case '-v':
        return getVariable({ name: operand }) !== undefined ? 0 : 1;
      case '-b':
      case '-c':
      case '-d':
      case '-e':
      case '-f':
      case '-h':
      case '-L':
      case '-p':
      case '-r':
      case '-s':
      case '-S':
      case '-t':
      case '-w':
      case '-x':
        return await evaluateUnaryFileTest({ operator, operand, cwd, files }) ? 0 : 1;
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled conditional unary operator: ${_ex}`);
      }
      }
    }
    case 'binary': {
      const left = await expandOperand({ operand: node.left, context: 'word' });
      const { operator } = node;
      switch (operator) {
      case '=':
      case '==':
      case '!=': {
        const pattern = await expandOperand({ operand: node.right, context: 'pattern' });
        const matches = matchesShellPattern({ pattern, text: left });
        return matches === (operator !== '!=') ? 0 : 1;
      }
      case '=~': {
        const pattern = await expandOperand({ operand: node.right, context: 'regex' });
        const characterClassMode = resolveCharacterLocaleMode({ env: { get: name => getVariable({ name }) } });
        try {
          return compileExtendedRegularExpression({
            source: pattern,
            flags: '',
            characterClassMode,
            gnuWordOperators: true,
            dotMode: 'non-null',
            excludeSurrogateEscapes: characterClassMode === 'unicode',
          }).test(left) ? 0 : 1;
        } catch (error: unknown) {
          if (error instanceof SyntaxError) {
            return 2;
          }
          throw error;
        }
      }
      case '<':
        return left < await expandOperand({ operand: node.right, context: 'word' }) ? 0 : 1;
      case '>':
        return left > await expandOperand({ operand: node.right, context: 'word' }) ? 0 : 1;
      case '-ef':
      case '-nt':
      case '-ot': {
        const right = await expandOperand({ operand: node.right, context: 'word' });
        return await evaluateBinaryFileTest({
          operator,
          leftOperand: left,
          rightOperand: right,
          cwd,
          files,
          checkActive,
        }) ? 0 : 1;
      }
      case '-eq':
      case '-ne':
      case '-lt':
      case '-le':
      case '-gt':
      case '-ge': {
        // Expand both words before either arithmetic evaluation can assign variables.
        const right = await expandOperand({ operand: node.right, context: 'word' });
        const lhs = await evaluateNumber({ expression: left });
        checkActive();
        if (lhs === undefined) {
          return 1;
        }
        const rhs = await evaluateNumber({ expression: right });
        checkActive();
        if (rhs === undefined) {
          return 1;
        }
        switch (operator) {
        case '-eq': return lhs === rhs ? 0 : 1;
        case '-ne': return lhs !== rhs ? 0 : 1;
        case '-lt': return lhs < rhs ? 0 : 1;
        case '-le': return lhs <= rhs ? 0 : 1;
        case '-gt': return lhs > rhs ? 0 : 1;
        case '-ge': return lhs >= rhs ? 0 : 1;
        default: {
          const _ex: never = operator;
          throw new Error(`Unhandled conditional arithmetic operator: ${_ex}`);
        }
        }
      }
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled conditional binary operator: ${_ex}`);
      }
      }
    }
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled conditional expression: ${_ex}`);
    }
    }
  }

  return evaluate({ node: expression });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
