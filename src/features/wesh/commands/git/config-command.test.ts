import { describe, expect, it } from 'vitest';
import { getBooleanConfigValue, getConfigValue, parseConfig, parseConfigKey, readCommandConfigEntries, registerGitCommandConfigEntries, TEST_ONLY } from './config';

describe('git command config transport', () => {
  it('keeps parsed command config typed without mutating string environment entries', () => {
    const env = new Map<string, string>([
      ['GIT_CONFIG_COUNT', '+01'],
      ['GIT_CONFIG_KEY_0', 'demo.from-env'],
      ['GIT_CONFIG_VALUE_0', 'environment'],
    ]);

    registerGitCommandConfigEntries({
      env,
      entries: [
        { key: 'demo.implicit', value: { kind: 'implicit-boolean' } },
        { key: 'demo.empty', value: { kind: 'explicit', value: '' } },
        { key: 'demo.value', value: { kind: 'explicit', value: 'command' } },
        { key: 'demo.sentinel-like', value: { kind: 'explicit', value: '\0wesh-git-implicit-boolean\0' } },
      ],
    });

    expect([...env]).toEqual([
      ['GIT_CONFIG_COUNT', '+01'],
      ['GIT_CONFIG_KEY_0', 'demo.from-env'],
      ['GIT_CONFIG_VALUE_0', 'environment'],
    ]);
    expect(readCommandConfigEntries({ env })).toEqual([
      { key: 'demo.from-env', value: { kind: 'explicit', value: 'environment' } },
      { key: 'demo.implicit', value: { kind: 'implicit-boolean' } },
      { key: 'demo.empty', value: { kind: 'explicit', value: '' } },
      { key: 'demo.value', value: { kind: 'explicit', value: 'command' } },
      { key: 'demo.sentinel-like', value: { kind: 'explicit', value: '\0wesh-git-implicit-boolean\0' } },
    ]);
  });

  it('does not reserve the removed sentinel spelling in external config transport', () => {
    const oldSentinel = '\0wesh-git-implicit-boolean\0';
    expect(readCommandConfigEntries({
      env: new Map([
        ['GIT_CONFIG_COUNT', '1'],
        ['GIT_CONFIG_KEY_0', 'demo.flag'],
        ['GIT_CONFIG_VALUE_0', oldSentinel],
      ]),
    })).toEqual([{ key: 'demo.flag', value: { kind: 'explicit', value: oldSentinel } }]);
  });

  it('distinguishes implicit and explicit-empty boolean config values', () => {
    const config = parseConfig({
      text: `\
[demo]
\timplicit
\tempty =
`,
    });
    expect(getBooleanConfigValue({ config, key: 'demo.implicit' })).toBe(true);
    expect(getBooleanConfigValue({ config, key: 'demo.empty' })).toBe(false);
  });

  it('parses supported escapes both inside and outside quotes', () => {
    const config = parseConfig({
      text: `\
[demo]
	quoted = "quote\\" slash\\\\ tab\\t newline\\n backspace\\b"
	unquoted = quote\\" slash\\\\ tab\\t newline\\n backspace\\b
`,
    });
    const expected = 'quote" slash\\ tab\t newline\n backspace\b';
    expect(getConfigValue({ config, key: 'demo.quoted' })).toBe(expected);
    expect(getConfigValue({ config, key: 'demo.unquoted' })).toBe(expected);
    expect(() => parseConfig({ text: '[demo]\nvalue = hello\\ world\n' })).toThrow('invalid config escape: \\ ');
    expect(() => parseConfig({ text: '[demo]\nvalue = foo\\#comment\n' })).toThrow('invalid config escape: \\#');
  });

  it('accepts comments after section headers', () => {
    const config = parseConfig({
      text: '[demo] # section comment\n\tvalue = one\n[other "Case"] ; subsection comment\n\tvalue = two\n',
    });
    expect(getConfigValue({ config, key: 'demo.value' })).toBe('one');
    expect(getConfigValue({ config, key: 'other.Case.value' })).toBe('two');
  });

  it('decodes quoted subsection escapes and accepts the same subsection in CLI keys', () => {
    const config = parseConfig({
      text: `[demo "quote\\" and slash\\\\"]
\tvalue = stored
`,
    });
    const key = 'demo.quote" and slash\\.value';
    expect(parseConfigKey({ key })).toEqual({
      section: 'demo',
      subsection: 'quote" and slash\\',
      name: 'value',
    });
    expect(getConfigValue({ config, key })).toBe('stored');
  });

  it('joins backslash-continued config lines before parsing values', () => {
    const config = parseConfig({
      text: '[demo]\n\tvalue = one\\\n three\n\tquoted = "left\\\n right"\n',
    });
    expect(getConfigValue({ config, key: 'demo.value' })).toBe('one three');
    expect(getConfigValue({ config, key: 'demo.quoted' })).toBe('left right');
  });

  it('preserves sectionless persisted entries for listing without widening CLI key grammar', () => {
    expect(parseConfig({ text: `\
foo = bar
flag
` })).toEqual(new Map([
      ['foo', { kind: 'explicit', value: 'bar' }],
      ['flag', { kind: 'implicit-boolean' }],
    ]));
    expect(() => parseConfigKey({ key: 'foo' })).toThrow('invalid key: foo');
  });

  it('rejects malformed persisted config lines instead of silently ignoring them', () => {
    expect(() => parseConfig({
      text: `[demo]
foo bar
`,
    })).toThrow('bad config line: foo bar');
    expect(() => parseConfig({
      text: `[demo
foo = bar
`,
    })).toThrow('bad config line: [demo');
  });

  it('rejects config variable names that do not start with a letter', () => {
    expect(() => parseConfigKey({ key: 'demo.1foo' })).toThrow('invalid key: demo.1foo');
    expect(() => parseConfig({
      text: `[demo]
1foo = value
`,
    })).toThrow('invalid config variable name: 1foo');
  });

  it('serializes config values so persisted values round-trip through Git syntax', () => {
    const values = [
      'plain',
      ' leading',
      'trailing ',
      'a # b',
      'a ; b',
      'a"b',
      'a\\b',
      `\
line1
line2`,
      'tab\tvalue',
      'backspace\bvalue',
      'carriage\rreturn',
    ];
    for (const value of values) {
      const persisted = TEST_ONLY.formatConfigValueForWrite({ value });
      const config = parseConfig({ text: `\
[demo]
value = ${persisted}
` });
      expect(getConfigValue({ config, key: 'demo.value' })).toBe(value);
    }
  });

  it('accepts Git-compatible non-negative GIT_CONFIG_COUNT spellings', () => {
    for (const rawCount of ['', '0', '00']) {
      expect(readCommandConfigEntries({
        env: new Map([['GIT_CONFIG_COUNT', rawCount]]),
      })).toEqual([]);
    }

    for (const rawCount of ['1', '01', '+1', ' 1 ']) {
      expect(readCommandConfigEntries({
        env: new Map([
          ['GIT_CONFIG_COUNT', rawCount],
          ['GIT_CONFIG_KEY_0', 'demo.flag'],
          ['GIT_CONFIG_VALUE_0', 'value'],
        ]),
      })).toEqual([{ key: 'demo.flag', value: { kind: 'explicit', value: 'value' } }]);
    }
  });
});
