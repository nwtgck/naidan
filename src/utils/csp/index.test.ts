import { Worker } from 'node:worker_threads';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import parserSource from './index.ts?raw';
import exactObjectSource from '@/utils/exact-object.ts?raw';
import * as publicParser from './index';
import { parseCsp } from './index';
import type { ParsedCsp, ParsedCspDirective } from './index';

function parsed({ serialized }: { serialized: string }): ParsedCsp {
  const result = parseCsp({ serialized });
  expect(result.kind).toBe('parsed');
  if (result.kind !== 'parsed') {
    throw new Error(`Unexpected parser failure: ${result.reason}`);
  }
  return result.value;
}

function directive({ serialized, index }: { serialized: string, index: number }): ParsedCspDirective {
  const value = parsed({ serialized }).policies[0]?.directives[index];
  if (value === undefined) {
    throw new Error('Expected directive');
  }
  return value;
}

describe('parseCsp', () => {
  it('exports exactly one callable entry point', () => {
    expect(Object.entries(publicParser).filter(([, value]) => typeof value === 'function').map(([name]) => name)).toEqual(['parseCsp']);
    expect(publicParser.TEST_ONLY).toEqual({});
  });

  it('preserves policy boundaries, original segments, directive case, and first occurrences', () => {
    const serialized = "  CONNECT-SRC 'self' ; connect-src https://later.invalid ;, img-src data: blob:  ";
    const value = parsed({ serialized });
    expect(value.serialized).toBe(serialized);
    expect(value.policies.map(policy => policy.serialized)).toEqual([
      "  CONNECT-SRC 'self' ; connect-src https://later.invalid ;", ' img-src data: blob:  ',
    ]);
    expect(value.policies[0]?.directives.map(item => ({
      name: item.name,
      originalName: item.originalName,
      occurrence: item.occurrence,
      duplicateOf: item.duplicateOf,
    }))).toEqual([
      { name: 'connect-src', originalName: 'CONNECT-SRC', occurrence: 'first', duplicateOf: undefined },
      { name: 'connect-src', originalName: 'connect-src', occurrence: 'duplicate', duplicateOf: 0 },
    ]);
    expect(value.policies[1]?.directives[0]?.tokens).toEqual(['data:', 'blob:']);
    expect(value.issues.filter(item => item.kind === 'duplicate-directive')).toHaveLength(1);
  });

  it('resets duplicate tracking for each policy and retains empty source lists', () => {
    const value = parsed({ serialized: 'connect-src; CONNECT-SRC https:, connect-src https:' });
    expect(value.policies[0]?.directives[0]?.tokens).toEqual([]);
    expect(value.policies[0]?.directives[0]?.sourceExpressions).toEqual([]);
    expect(value.policies[0]?.directives[1]?.occurrence).toBe('duplicate');
    expect(value.policies[1]?.directives[0]?.occurrence).toBe('first');
  });

  it.each(['', ' \t\r\n\f ', ',,  ,'])('handles empty list input without inventing a restriction: %j', serialized => {
    expect(parsed({ serialized }).policies).toEqual([]);
  });

  it('splits only on ASCII whitespace and retains non-ASCII directives without claiming first-win', () => {
    const serialized = "connect-src 'self'\u00a0https://blocked.invalid; CONNECT-SRC https:; img-src\v'self'; script-src\t'none'\n'unsafe-eval'";
    const value = parsed({ serialized });
    const items = value.policies[0]?.directives;
    expect(items?.[0]?.occurrence).toBe('ignored-non-ascii');
    expect(items?.[0]?.tokens).toEqual(["'self'\u00a0https://blocked.invalid"]);
    expect(items?.[1]?.occurrence).toBe('first');
    expect(items?.[1]?.duplicateOf).toBeUndefined();
    expect(items?.[2]?.name).toBe("img-src\v'self'");
    expect(items?.[2]?.issues.map(item => item.kind)).toContain('invalid-directive-name');
    expect(items?.[3]?.tokens).toEqual(["'none'", "'unsafe-eval'"]);
  });

  it('retains unknown directive values as tokens without source-list interpretation', () => {
    const value = parsed({ serialized: "X-Future-Directive mode(v2) 'future-token'; sandbox allow-scripts; report-to reporting; trusted-types app 'allow-duplicates'; webrtc 'block'" });
    const items = value.policies[0]?.directives;
    expect(items?.[0]?.name).toBe('x-future-directive');
    expect(items?.[0]?.tokens).toEqual(['mode(v2)', "'future-token'"]);
    expect(items?.[0]?.issues.map(item => item.kind)).toContain('unknown-directive');
    expect(items?.map(item => item.sourceExpressions)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('keeps opaque source expressions so future semantics cannot become an exclusion silently', () => {
    const item = directive({ serialized: "connect-src 'self' 'future-v2' new-mode(v2) https://[::1]:*", index: 0 });
    expect(item.sourceExpressions).toEqual([
      { kind: 'keyword', serialized: "'self'", value: 'self' },
      { kind: 'unknown', serialized: "'future-v2'" },
      { kind: 'unknown', serialized: 'new-mode(v2)' },
      { kind: 'unknown', serialized: 'https://[::1]:*' },
    ]);
  });

  it('structures schemes, wildcards, ports, and paths without passing expressions through URL', () => {
    const item = directive({ serialized: 'connect-src HTTPS://*.Example.COM:00443/Case/%2f https: http://localhost:* * example.org. custom+scheme://Host:123/a@b', index: 0 });
    expect(item.sourceExpressions).toEqual([
      { kind: 'host', serialized: 'HTTPS://*.Example.COM:00443/Case/%2f', scheme: 'https', host: 'example.com', wildcard: 'subdomains', port: '00443', path: '/Case/%2f' },
      { kind: 'scheme', serialized: 'https:', scheme: 'https' },
      { kind: 'host', serialized: 'http://localhost:*', scheme: 'http', host: 'localhost', wildcard: 'none', port: '*', path: undefined },
      { kind: 'host', serialized: '*', scheme: undefined, host: '*', wildcard: 'any', port: undefined, path: undefined },
      { kind: 'host', serialized: 'example.org.', scheme: undefined, host: 'example.org.', wildcard: 'none', port: undefined, path: undefined },
      { kind: 'host', serialized: 'custom+scheme://Host:123/a@b', scheme: 'custom+scheme', host: 'host', wildcard: 'none', port: '123', path: '/a@b' },
    ]);
  });

  it('preserves nonce and digest case while recognizing their grammar case-insensitively', () => {
    const item = directive({ serialized: "script-src 'SELF' 'Nonce-AbCd-_==' 'SHA256-XyZ+/_=' 'sha384-aB9' 'sha512-AbC'", index: 0 });
    expect(item.sourceExpressions).toEqual([
      { kind: 'keyword', serialized: "'SELF'", value: 'self' },
      { kind: 'nonce', serialized: "'Nonce-AbCd-_=='", value: 'AbCd-_==' },
      { kind: 'hash', serialized: "'SHA256-XyZ+/_='", algorithm: 'sha256', value: 'XyZ+/_=' },
      { kind: 'hash', serialized: "'sha384-aB9'", algorithm: 'sha384', value: 'aB9' },
      { kind: 'hash', serialized: "'sha512-AbC'", algorithm: 'sha512', value: 'AbC' },
    ]);
  });

  it('distinguishes malformed known expressions from unknown extensions without failing the policy', () => {
    const item = directive({ serialized: "script-src 'nonce-' 'sha256-a===b' 'sha999-Future' 'self", index: 0 });
    expect(item.sourceExpressions?.map(expression => expression.kind)).toEqual(['invalid', 'invalid', 'unknown', 'invalid']);
    expect(item.issues.filter(entry => entry.kind === 'invalid-source-expression')).toHaveLength(3);
  });

  it.each(['https://example.org/a%xx', 'https://example.org/a?query', 'https://example.org/a#fragment', 'https://example.org:', 'https://*.example.org:abc'])('keeps unsupported host syntax opaque: %s', expression => {
    expect(directive({ serialized: `connect-src ${expression}`, index: 0 }).sourceExpressions).toEqual([{ kind: 'unknown', serialized: expression }]);
  });

  it('reports positions relative to the complete serialized header', () => {
    const serialized = " img-src data:, connect-src 'future-v2' ";
    const value = parsed({ serialized });
    const entry = value.issues.find(item => item.kind === 'unknown-source-expression');
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(serialized.slice(entry.start, entry.end)).toBe("'future-v2'");
    }
  });

  it('does not interpret prototype-like names as existing properties', () => {
    const value = parsed({ serialized: 'constructor a; __proto__ b; constructor c; toString d' });
    expect(value.policies[0]?.directives.map(item => item.occurrence)).toEqual(['first', 'first', 'duplicate', 'first']);
    expect(value.policies[0]?.directives[2]?.duplicateOf).toBe(0);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('freezes every public container and preserves the cached structure after mutation attempts', () => {
    const result = parseCsp({ serialized: "connect-src 'self' 'future-v2'; connect-src https:" });
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') {
      throw new Error('Expected parsed result');
    }
    const pending: unknown[] = [result];
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === 'object' && current !== null) {
        expect(Object.isFrozen(current)).toBe(true);
        pending.push(...Object.values(current));
      }
    }
    expect(Reflect.set(result.value.policies, '0', {})).toBe(false);
    expect(Reflect.set(result.value, 'serialized', 'changed')).toBe(false);
    expect(result.value.serialized).toBe("connect-src 'self' 'future-v2'; connect-src https:");
  });

  it.each([
    { serialized: ' '.repeat(65537), reason: 'input-too-long' },
    { serialized: Array.from({ length: 129 }, () => "default-src 'none'").join(','), reason: 'too-many-policies' },
    { serialized: Array.from({ length: 1025 }, () => 'sandbox').join(';'), reason: 'too-many-directives' },
    { serialized: `connect-src ${Array.from({ length: 8193 }, () => 'x').join(' ')}`, reason: 'too-many-tokens' },
  ])('returns a complete failure without partial AST at $reason', ({ serialized, reason }) => {
    const result = parseCsp({ serialized });
    expect(result).toEqual({ kind: 'failed', reason });
    expect(Object.isFrozen(result)).toBe(true);
    expect('value' in result).toBe(false);
  });

  it('accepts the exact budgets and counts duplicate and non-source tokens toward the same bound', () => {
    expect(parseCsp({ serialized: ' '.repeat(65536) }).kind).toBe('parsed');
    expect(parsed({ serialized: Array.from({ length: 128 }, () => 'sandbox').join(',') }).policies).toHaveLength(128);
    expect(parsed({ serialized: Array.from({ length: 1024 }, () => 'sandbox').join(';') }).policies[0]?.directives).toHaveLength(1024);
    const tokens = Array.from({ length: 4096 }, () => 'x').join(' ');
    expect(parseCsp({ serialized: `future ${tokens}; future ${tokens}` }).kind).toBe('parsed');
    expect(parseCsp({ serialized: `future ${tokens}; future ${tokens} x` })).toEqual({ kind: 'failed', reason: 'too-many-tokens' });
  });

  it('finishes bounded adversarial inputs under a separate worker watchdog', async () => {
    const compilerOptions = { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 };
    const parserCode = transpileModule(parserSource, { compilerOptions }).outputText;
    const helperCode = transpileModule(exactObjectSource, { compilerOptions }).outputText;
    const code = `\
const { parentPort, workerData } = require('node:worker_threads');
const helperExports = {};
new Function('exports', workerData.helperCode)(helperExports);
const parserExports = {};
const requirePureHelper = specifier => {
  if (specifier !== '@/utils/exact-object') throw new Error('Unexpected parser dependency');
  return helperExports;
};
new Function('exports', 'require', workerData.parserCode)(parserExports, requirePureHelper);
const inputs = [
  ','.repeat(65536),
  ';'.repeat(65536),
  'connect-src ' + '('.repeat(65524),
  'connect-src ' + Array(8192).fill("'x'").join(' '),
  'report-to ' + 'x'.repeat(65526),
];
for (const serialized of inputs) {
  const result = parserExports.parseCsp({ serialized });
  if (result.kind !== 'parsed') throw new Error('Bounded input did not complete');
}
parentPort.postMessage('complete');
`;
    // Only the actual pure modules and fixed inputs enter this worker. Its
    // module resolver cannot load files, networking APIs, or other binaries.
    const worker = new Worker(code, {
      eval: true,
      execArgv: [],
      env: {},
      name: 'csp-parser-watchdog',
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 1 },
      workerData: { parserCode, helperCode },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        clearTimeout(timer);
        await worker.terminate();
      },
    };
    void cleanup;
    const output = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('CSP parser watchdog expired'));
      }, 10000);
      worker.once('message', (message: unknown) => {
        if (message === 'complete') {
          resolve(message);
        } else {
          reject(new Error('Unexpected CSP parser worker result'));
        }
      });
      worker.once('error', reject);
      worker.once('exit', code => {
        reject(new Error(`CSP parser worker exited before a result: ${code}`));
      });
    });
    expect(output).toBe('complete');
  }, 15000);
});
