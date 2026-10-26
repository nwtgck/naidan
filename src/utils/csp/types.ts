export type CspParseIssue = Readonly<{
  kind: 'duplicate-directive' | 'non-ascii-directive' | 'invalid-directive-name' | 'invalid-directive-value' | 'unknown-directive' | 'unknown-source-expression' | 'invalid-source-expression';
  start: number,
  end: number,
}>;

export type ParsedCspSourceExpression =
  | Readonly<{ kind: 'keyword', serialized: string, value: string }>
  | Readonly<{ kind: 'scheme', serialized: string, scheme: string }>
  | Readonly<{
    kind: 'host',
    serialized: string,
    scheme: string | undefined,
    host: string,
    wildcard: 'none' | 'subdomains' | 'any',
    port: string | undefined,
    path: string | undefined,
  }>
  | Readonly<{ kind: 'nonce', serialized: string, value: string }>
  | Readonly<{ kind: 'hash', serialized: string, algorithm: 'sha256' | 'sha384' | 'sha512', value: string }>
  | Readonly<{ kind: 'unknown', serialized: string }>
  | Readonly<{ kind: 'invalid', serialized: string }>;

export type ParsedCspDirective = Readonly<{
  serialized: string,
  name: string,
  originalName: string,
  value: string,
  tokens: readonly string[],
  sourceExpressions: readonly ParsedCspSourceExpression[] | undefined,
  occurrence: 'first' | 'duplicate' | 'ignored-non-ascii',
  duplicateOf: number | undefined,
  issues: readonly CspParseIssue[],
}>;

export type ParsedCspPolicy = Readonly<{
  serialized: string,
  directives: readonly ParsedCspDirective[],
  issues: readonly CspParseIssue[],
}>;

export type ParsedCsp = Readonly<{
  serialized: string,
  policies: readonly ParsedCspPolicy[],
  issues: readonly CspParseIssue[],
}>;

export type CspParseResult =
  | Readonly<{ kind: 'parsed', value: ParsedCsp }>
  | Readonly<{ kind: 'failed', reason: 'input-too-long' | 'too-many-policies' | 'too-many-directives' | 'too-many-tokens' }>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
