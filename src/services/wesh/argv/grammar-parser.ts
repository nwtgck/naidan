import type { ParsedFindLikeArgv } from './types';

const FIND_EXPRESSION_TOKENS = new Set([
  '!',
  '(',
  ')',
  ',',
  '-a',
  '-and',
  '-false',
  '-iname',
  '-name',
  '-not',
  '-o',
  '-or',
  '-path',
  '-print',
  '-prune',
  '-true',
  '-type',
]);

function isFindExpressionToken({ token }: { token: string }): boolean {
  if (FIND_EXPRESSION_TOKENS.has(token)) return true;
  return token.startsWith('-') && token !== '-';
}

export function parseFindLikeArgv({
  args,
}: {
  args: string[];
}): ParsedFindLikeArgv {
  const paths: string[] = [];
  let index = 0;

  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;
    if (isFindExpressionToken({ token })) break;
    paths.push(token);
    index += 1;
  }

  return {
    paths: paths.length > 0 ? paths : ['.'],
    expressionTokens: args.slice(index),
  };
}
