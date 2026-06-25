import { describe, expect, it } from 'vitest';

import type { BuildLicenseDependency } from './license-dependencies';
import { serializeLicenseDependencies } from './license-payload';

function evaluateLicenseExpression({ expression }: {
  expression: string,
}): readonly BuildLicenseDependency[] {
  return new Function(`return (${expression})`)() as readonly BuildLicenseDependency[];
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

describe('serializeLicenseDependencies', () => {
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

    const expression = serializeLicenseDependencies({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(expression).toContain('(d=>[');
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

    const expression = serializeLicenseDependencies({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(expression.match(/licenseText:d\[0\]/g)).toHaveLength(2);
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

    const expression = serializeLicenseDependencies({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
  });

  it('keeps the plain array expression when dictionary syntax would not reduce output', () => {
    const dependencies = [
      createDependency({ name: 'package-a', license: 'MIT', licenseText: 'unique A' }),
      createDependency({ name: 'package-b', license: 'MIT', licenseText: 'unique B' }),
    ];

    const expression = serializeLicenseDependencies({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(expression).not.toContain('(d=>');
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

    const expression = serializeLicenseDependencies({ dependencies });

    expect(evaluateLicenseExpression({ expression })).toEqual(dependencies);
    expect(Buffer.byteLength(expression, 'utf8')).toBeLessThan(Buffer.byteLength(JSON.stringify(dependencies), 'utf8'));
  });
});
