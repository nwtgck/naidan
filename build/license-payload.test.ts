import { runInNewContext } from 'node:vm';
import { parse } from '@babel/parser';
import { transformSync } from '@babel/core';
import { minify } from 'rolldown/utils';
import { babelTransformModulesSystemjsPlugin, babelTraverse } from './file-protocol-standalone/babel-runtime';
import { describe, expect, it } from 'vitest';

import type { BuildLicenseDependency } from './license-dependencies';
import { serializeLicenseCatalogFactory } from './license-payload';
import { restoreLicenseCatalog } from './test-support/license-catalog.test-support';
import type { NaidanLicense, NaidanLicenseCatalog } from '../src/01-models/naidan-license';

function evaluateLicenseExpression({ expression }: {
  expression: string,
}): readonly NaidanLicense[] {
  return restoreLicenseCatalog({ factory: new Function(`return (${expression})`)() });
}

function createDependency({ name, license, licenseText }: {
  name: string,
  license: string,
  licenseText: string | null,
}): BuildLicenseDependency {
  return {
    name,
    version: '1.0.0',
    license,
    licenseText,
  };
}

describe('serializeLicenseCatalogFactory', () => {
  it('compresses actual repeated text rather than inferring equality from the license identifier', () => {
    const commonGrant = `\

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files.
`;
    const commonDisclaimer = `\

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE.
`;
    const dependencies = [
      createDependency({
        name: 'package-a',
        license: 'MIT',
        licenseText: `Copyright package A${commonGrant}Package A notice${commonDisclaimer}`,
      }),
      createDependency({
        name: 'package-b',
        license: 'Custom',
        licenseText: `Copyright package B${commonGrant}Package B notice${commonDisclaimer}`,
      }),
      createDependency({
        name: 'package-c',
        license: 'MIT',
        licenseText: 'A different MIT-identified text that must not be treated as equal.',
      }),
    ];

    const expression = serializeLicenseCatalogFactory({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(expression).toContain('const d=[');
    expect(expression.match(/d\[\d+\]/g)?.length).toBeGreaterThanOrEqual(4);
    expect(expression).toContain('license:"Custom"');
    expect(expression).not.toContain('.map(');
    expect(expression).not.toContain('.join(');
    expect(expression).not.toContain('JSON.parse');
  });

  it('uses one dictionary value when complete license texts are equal', () => {
    const repeatedText = `\
MIT License

Copyright shared

A sufficiently long license body that is exactly the same in both packages.
`;
    const dependencies = [
      createDependency({ name: 'package-a', license: 'MIT', licenseText: repeatedText }),
      createDependency({ name: 'package-b', license: 'SEE LICENSE', licenseText: repeatedText }),
    ];

    const expression = serializeLicenseCatalogFactory({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(expression.match(/return d\[0\];/g)).toHaveLength(2);
    expect(expression).toContain(JSON.stringify(repeatedText));
  });

  it('preserves original code units including newline styles, Unicode, empty text, and null', () => {
    const sharedCrlfText = `Shared line with emoji 😀\r\nSecond shared line\r\n`;
    const dependencies = [
      createDependency({
        name: 'crlf-a',
        license: 'Custom',
        licenseText: `Prefix A\r\n${sharedCrlfText}`,
      }),
      createDependency({
        name: 'crlf-b',
        license: 'Custom',
        licenseText: `Prefix B\r\n${sharedCrlfText}`,
      }),
      createDependency({ name: 'empty', license: 'Unknown', licenseText: '' }),
      createDependency({ name: 'missing', license: 'Unknown', licenseText: null }),
    ];

    const expression = serializeLicenseCatalogFactory({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
  });

  it('omits the reader dictionary when its syntax would not reduce output', () => {
    const dependencies = [
      createDependency({ name: 'package-a', license: 'MIT', licenseText: 'unique A' }),
      createDependency({ name: 'package-b', license: 'MIT', licenseText: 'unique B' }),
    ];

    const expression = serializeLicenseCatalogFactory({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(expression).not.toContain('const d=');
    expect(expression).not.toContain('d[');
  });

  it('reduces the complete generated JavaScript expression for representative license text', () => {
    const sharedBody = `\

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files, to deal in the Software
without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;
    const dependencies = Array.from({ length: 20 }, (_, index) => createDependency({
      name: `package-${index}`,
      license: index % 2 === 0 ? 'MIT' : 'Custom',
      licenseText: `Copyright package ${index}${sharedBody}`,
    }));

    const expression = serializeLicenseCatalogFactory({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(Buffer.byteLength(expression, 'utf8')).toBeLessThan(Buffer.byteLength(JSON.stringify(dependencies), 'utf8'));
  });

  it.each([false, true])('keeps highly fragmented notices parseable through SystemJS conversion with minify=%s', async shouldMinify => {
    const sharedNotice = 'Shared native notice: redistribution conditions and disclaimer must remain unchanged.\r\n';
    const licenseText = Array.from({ length: 6000 }, (_, index) => (
      `Copyright ${index} "quoted" \\ 😀\r${sharedNotice}`
    )).join('');
    const dependencies = [createDependency({ name: 'fragmented-native-notices', license: 'Custom', licenseText })];
    const expression = serializeLicenseCatalogFactory({ dependencies });
    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(Buffer.byteLength(expression)).toBeLessThan(Buffer.byteLength(JSON.stringify(dependencies)));

    // A Function-only round trip does not exercise Babel's recursive parser and
    // traversal, which inspect the emitted module during standalone packaging.
    const source = `export default ${expression};`;
    const transformed = transformSync(source, {
      babelrc: false,
      configFile: false,
      plugins: [babelTransformModulesSystemjsPlugin],
    });
    if (typeof transformed?.code !== 'string') {
      throw new Error('Expected transformed SystemJS license module');
    }
    const code = shouldMinify
      ? (await minify('native-licenses.js', transformed.code, { compress: true, mangle: true })).code
      : transformed.code;
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    babelTraverse(ast, {});

    let restored: unknown;
    runInNewContext(code, {
      System: {
        register(imports: unknown[], declare: (publish: (name: string, value: unknown) => void) => { execute(): void }) {
          expect(imports).toEqual([]);
          declare((name, value) => {
            expect(name).toBe('default');
            restored = value;
          }).execute();
        },
      },
    });
    expect(restoreLicenseCatalog({ factory: restored })).toEqual(dependencies);
  });
});

function evaluateCatalogFactory({ dependencies }: { dependencies: readonly NaidanLicense[] }): () => NaidanLicenseCatalog {
  const expression = serializeLicenseCatalogFactory({ dependencies });
  return new Function(`return (${expression})`)() as () => NaidanLicenseCatalog;
}

describe('lazy license catalog lifetime and exactness', () => {
  it('creates fresh metadata without caching catalogs or attaching bodies to entries', () => {
    const dependencies: readonly NaidanLicense[] = [
      { name: 'same-name', version: '1', license: 'MIT', licenseText: 'JavaScript notice' },
      { id: 'native:one', origin: 'native', name: 'same-name', version: null, license: null, licenseText: 'Native notice' },
      { id: '', origin: '', name: '', version: '', license: '', licenseText: '' },
    ];
    const factory = evaluateCatalogFactory({ dependencies });
    const first = factory();
    const second = factory();
    expect(first).not.toBe(second);
    expect(first.entries).not.toBe(second.entries);
    for (const [index, entry] of first.entries.entries()) {
      expect(entry).not.toHaveProperty('licenseText');
      expect(entry).not.toBe(second.entries[index]);
    }
    expect(first.entries).toEqual([
      { name: 'same-name', version: '1', license: 'MIT' },
      { id: 'native:one', origin: 'native', name: 'same-name', version: null, license: null },
      { id: '', origin: '', name: '', version: '', license: '' },
    ]);
    expect(restoreLicenseCatalog({ factory })).toEqual(dependencies);
    expect(first.readLicenseText({ index: 1 })).toBe('Native notice');
    expect(first.readLicenseText({ index: 0 })).toBe('JavaScript notice');
  });

  it('supports an empty catalog and rejects every invalid index rather than treating it as a missing body', () => {
    const empty = evaluateCatalogFactory({ dependencies: [] })();
    expect(empty.entries).toEqual([]);
    expect(() => empty.readLicenseText({ index: 0 })).toThrow(RangeError);
    const catalog = evaluateCatalogFactory({ dependencies: [createDependency({ name: 'missing', license: 'Unknown', licenseText: null })] })();
    expect(catalog.readLicenseText({ index: 0 })).toBeNull();
    for (const index of [-1, 1, 0.5, NaN, Infinity, -Infinity, '0' as unknown as number]) {
      expect(() => catalog.readLicenseText({ index })).toThrow(RangeError);
    }
  });

  it.each(['raw', 'minified', 'systemjs-minified'] as const)('restores only the requested text and keeps its dictionary local after %s output', async format => {
    const shared = 'Exact shared permission and disclaimer text that should occur just once in the dictionary.\r\n';
    const fragmented = Array.from({ length: 40 }, (_, index) => `Unique ${index}\r${shared}`).join('');
    const dependencies = [
      createDependency({ name: 'simple', license: 'Custom', licenseText: 'Short unique notice' }),
      createDependency({ name: 'fragmented', license: 'Custom', licenseText: fragmented }),
    ];
    const expression = serializeLicenseCatalogFactory({ dependencies });
    expect(expression).toContain('readLicenseText:({index})=>{const d=');
    expect(expression).toContain('.join("")');
    const events: number[] = [];
    let factory: (() => NaidanLicenseCatalog) | undefined;
    const context = {
      recordJoin: () => events.push(1),
      publishFactory: (value: () => NaidanLicenseCatalog) => {
        factory = value;
      },
      System: {
        register(_imports: unknown[], declare: (publish: (name: string, value: () => NaidanLicenseCatalog) => void) => { execute(): void }) {
          declare((_name, value) => {
            factory = value;
          }).execute();
        },
      },
    };
    let code = `publishFactory(${expression});`;
    if (format === 'systemjs-minified') {
      const transformed = transformSync(`export default ${expression};`, {
        babelrc: false,
        configFile: false,
        plugins: [babelTransformModulesSystemjsPlugin],
      });
      if (typeof transformed?.code !== 'string') {
        throw new Error('Expected transformed SystemJS license factory');
      }
      code = transformed.code;
    }
    if (format !== 'raw') {
      code = (await minify('lazy-license.js', code, { compress: true, mangle: true })).code;
    }
    runInNewContext(`\
const originalJoin = Array.prototype.join;
Array.prototype.join = function(separator) {
  recordJoin();
  return originalJoin.call(this, separator);
};
${code}
`, context);
    if (factory === undefined) {
      throw new Error('Expected a generated factory');
    }
    const catalog = factory();
    expect(events).toEqual([]);
    expect(catalog.readLicenseText({ index: 0 })).toBe('Short unique notice');
    expect(events).toEqual([]);
    expect(catalog.readLicenseText({ index: 1 })).toBe(fragmented);
    expect(events).toEqual([1]);
    // No reconstructed body is cached on the catalog: reading again assembles again.
    expect(catalog.readLicenseText({ index: 1 })).toBe(fragmented);
    expect(events).toEqual([1, 1]);
    expect(Object.keys(catalog).sort()).toEqual(['entries', 'readLicenseText']);
  });

  it('pays the reader-local declaration cost before adopting the first dictionary entry', () => {
    for (let length = 1; length <= 60; length++) {
      const text = 'x'.repeat(length);
      const dependencies = [
        createDependency({ name: 'a', license: 'Custom', licenseText: text }),
        createDependency({ name: 'b', license: 'Custom', licenseText: text }),
      ];
      const expression = serializeLicenseCatalogFactory({ dependencies });
      const literal = JSON.stringify(text);
      const withDictionary = expression.includes('const d=');
      const saving = Buffer.byteLength(literal) - Buffer.byteLength('const d=[];') - 2 * Buffer.byteLength('d[0]');
      expect(withDictionary).toBe(saving > 0);
      expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    }
  });

  it('round-trips overlapping repeated blocks, escape sequences and mixed line endings deterministically', () => {
    const lines = ['shared permission\n', 'shared disclaimer\r\n', '😀\r', '"\\\u0000\u2028\u2029\ud800\n', 'same prefix\r\n'];
    for (let sample = 0; sample < 24; sample++) {
      const dependencies = Array.from({ length: 4 }, (_, item) => createDependency({
        name: `package-${sample}-${item}`,
        license: item % 2 === 0 ? 'MIT' : 'Custom',
        licenseText: Array.from({ length: 32 }, (_, line) => (
          (line + sample + item) % 7 === 0 ? `unique ${sample}:${item}:${line}\r\n` : lines[(sample + line) % lines.length]
        )).join(''),
      }));
      const first = serializeLicenseCatalogFactory({ dependencies });
      expect(serializeLicenseCatalogFactory({ dependencies })).toBe(first);
      expect(evaluateLicenseExpression({ expression: first })).toEqual(dependencies);
    }
  });
});
