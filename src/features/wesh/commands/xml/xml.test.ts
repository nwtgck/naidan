import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh xml', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string,
    stdinText: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints top-level help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xml --help',
      stdinText: '',
    });

    expect(stdout.text).toContain('XMLStarlet-like XML toolkit');
    expect(stdout.text).toContain('sel');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports xml sel -t -v against files', async () => {
    await writeFile({
      path: 'books.xml',
      data: `\
<catalog>
  <book id="b1"><title>Alpha</title></book>
  <book id="b2"><title>Beta</title></book>
</catalog>`,
    });

    const { result, stdout, stderr } = await execute({
      script: `xml sel -t -v '//book[@id="b2"]/title' -n books.xml`,
      stdinText: '',
    });

    expect(stdout.text).toBe('Beta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses XML whitespace rules around XPath expressions', async () => {
    await writeFile({ path: 'root.xml', data: '<root>ok</root>\n' });

    for (const expression of ['/root', ' /root ', '\t/root\t', '\n/root\n', '\r/root\r']) {
      const { result, stdout, stderr } = await execute({
        script: `xml sel -t -v '${expression}' -n root.xml`,
        stdinText: '',
      });
      expect(stdout.text).toBe('ok\n');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }

    {
      const { result, stdout, stderr } = await execute({
        script: `xml sel -t -v 'string("\u00A0")' -n root.xml`,
        stdinText: '',
      });
      expect(stdout.text).toBe('\u00A0\n');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }

    for (const expression of ['\u00A0/root\u00A0', '\u2003/root', '\uFEFF/root', '/root\u00A0']) {
      const { result, stdout, stderr } = await execute({
        script: `xml sel -t -v '${expression}' -n root.xml`,
        stdinText: '',
      });
      expect(stdout.text).toBe('');
      expect(stderr.text).not.toBe('');
      expect(result.exitCode).toBe(4);
    }
  });

  it('supports multiple template actions in order', async () => {
    await writeFile({
      path: 'books.xml',
      data: `\
<catalog>
  <book id="b1"><title>Alpha</title></book>
</catalog>`,
    });

    const { result, stdout, stderr } = await execute({
      script: `xml sel -t -v 'string(//book/@id)' -n -c '//book/title' -n books.xml`,
      stdinText: '',
    });

    expect(stdout.text).toContain('b1\n');
    expect(stdout.text).toContain('<title>Alpha</title>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports xml sel -t -c against stdin', async () => {
    const { result, stdout, stderr } = await execute({
      script: `xml sel -t -c '//book[@id="b1"]' -n -`,
      stdinText: `\
<catalog>
  <book id="b1"><title>Alpha</title></book>
  <book id="b2"><title>Beta</title></book>
</catalog>`,
    });

    expect(stdout.text).toContain('<book id="b1">');
    expect(stdout.text).toContain('<title>Alpha</title>');
    expect(stdout.text.endsWith('\n')).toBe(true);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('escapes value output by default and supports raw text mode', async () => {
    await writeFile({
      path: 'escaped.xml',
      data: '<root><value>Alpha &amp; &lt;Beta&gt;</value></root>',
    });

    const escaped = await execute({
      script: `xml sel -t -v '/root/value' -n escaped.xml`,
      stdinText: '',
    });
    const text = await execute({
      script: `xml sel -T -t -v '/root/value' -n escaped.xml`,
      stdinText: '',
    });
    const longText = await execute({
      script: `xml sel --text -t -v '/root/value' -n escaped.xml`,
      stdinText: '',
    });

    expect(escaped.stdout.text).toBe('Alpha &amp; &lt;Beta&gt;\n');
    expect(text.stdout.text).toBe('Alpha & <Beta>\n');
    expect(longText.stdout.text).toBe(text.stdout.text);
    expect(escaped.stderr.text).toBe('');
    expect(text.stderr.text).toBe('');
    expect(longText.stderr.text).toBe('');
    expect(escaped.result.exitCode).toBe(0);
    expect(text.result.exitCode).toBe(0);
    expect(longText.result.exitCode).toBe(0);
  });

  it('matches XMLStarlet node-set, root-context, and text copy semantics', async () => {
    await writeFile({
      path: 'contexts.xml',
      data: '<root><item id="1">alpha</item><item id="2">beta</item><empty/></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v '/root/item/@id' -n -v . -n -m '/root/item' -v 'name()' -o ':' -v 'position()' -o '/' -v 'last()' -n -b contexts.xml`,
      stdinText: '',
    });
    const emptyCopy = await execute({
      script: `xml sel -T -t -c '/root/empty' contexts.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
1
2
alphabeta
item:1/2
item:2/2
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
    expect(emptyCopy.stdout.text).toBe('');
    expect(emptyCopy.stderr.text).toBe('');
    expect(emptyCopy.result.exitCode).toBe(0);
  });

  it('renders deeply nested match actions without host stack recursion', async () => {
    const depth = 20_000;
    const result = await execute({
      script: `xml sel -t ${'-m . '.repeat(depth)}-o ok -`,
      stdinText: '<root/>\n',
    });

    expect(result.stdout.text).toBe('ok');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('evaluates deeply parenthesized XPath scalars without host stack recursion', async () => {
    const depth = 20_000;
    const expression = `${'('.repeat(depth)}1${')'.repeat(depth)}`;
    const result = await execute({
      script: `xml sel -T -t -v '${expression}' -n -`,
      stdinText: '<root/>\n',
    });

    expect(result.stdout.text).toBe('1\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses first namespace binding and rejects global options after template mode', async () => {
    await writeFile({
      path: 'namespace-order.xml',
      data: '<r:root xmlns:r="urn:right"><r:item/></r:root>',
    });

    const bindingOrder = await execute({
      script: `xml sel -T -N r=urn:wrong -N r=urn:right -t -v 'count(/r:root/r:item)' -n namespace-order.xml`,
      stdinText: '',
    });
    const misplacedGlobal = await execute({
      script: `xml sel -t -v '/r:root' -N r=urn:right namespace-order.xml`,
      stdinText: '',
    });

    expect(bindingOrder.stdout.text).toBe('0\n');
    expect(bindingOrder.stderr.text).toBe('');
    expect(bindingOrder.result.exitCode).toBe(0);
    expect(misplacedGlobal.stdout.text).toBe('');
    expect(misplacedGlobal.stderr.text).toContain("xml sel: unsupported option '-N'");
    expect(misplacedGlobal.result.exitCode).toBe(2);
  });

  it('uses XMLStarlet-compatible data and XPath failure exit codes', async () => {
    const missing = await execute({
      script: `xml sel -t -v / -n missing.xml`,
      stdinText: '',
    });
    const malformed = await execute({
      script: `xml sel -t -v / -n -`,
      stdinText: '<root>',
    });
    await writeFile({ path: 'valid.xml', data: '<root />' });
    const invalidXPath = await execute({
      script: `xml sel -t -v '//*[' -n valid.xml`,
      stdinText: '',
    });

    expect(missing.result.exitCode).toBe(3);
    expect(malformed.result.exitCode).toBe(3);
    expect(invalidXPath.result.exitCode).toBe(4);
    expect(missing.stderr.text).not.toBe('');
    expect(malformed.stderr.text).not.toBe('');
    expect(invalidXPath.stderr.text).not.toBe('');
  });

  it('matches XMLStarlet quiet multi-input parse-error state', async () => {
    await writeFile({ path: 'quiet-good-one.xml', data: '<root><item>one</item></root>' });
    await writeFile({ path: 'quiet-bad.xml', data: '<root><item>broken</root>' });
    await writeFile({ path: 'quiet-good-two.xml', data: '<root><item>two</item></root>' });

    const laterFailure = await execute({
      script: `xml sel -Q -t -v '/root/item' quiet-good-one.xml quiet-bad.xml quiet-good-two.xml`,
      stdinText: '',
    });
    const firstFailure = await execute({
      script: `xml sel -Q -t -v '/root/item' quiet-bad.xml quiet-good-one.xml`,
      stdinText: '',
    });
    const singleFailure = await execute({
      script: `xml sel -Q -t -v '/root/item' quiet-bad.xml`,
      stdinText: '',
    });

    expect(laterFailure.stdout.text).toBe('');
    expect(laterFailure.stderr.text).toBe('');
    expect(laterFailure.result.exitCode).toBe(0);
    expect(firstFailure.stdout.text).toBe('');
    expect(firstFailure.stderr.text).not.toBe('');
    expect(firstFailure.result.exitCode).toBe(0);
    expect(singleFailure.stdout.text).toBe('');
    expect(singleFailure.stderr.text).not.toBe('');
    expect(singleFailure.result.exitCode).toBe(3);
  });

  it('matches XMLStarlet branch and post-input argument state', async () => {
    await writeFile({ path: 'argument-state.xml', data: '<root><item>one</item><item>two</item></root>' });

    const duplicateElse = await execute({
      script: `xml sel -t -i 'true()' --else --else -o x`,
      stdinText: '<root/>',
    });
    const elifAfterElse = await execute({
      script: `xml sel -t -i 'true()' --else --elif 'false()' -o x`,
      stdinText: '<root/>',
    });
    const actionAfterInput = await execute({
      script: `xml sel -t -v '/root/item' argument-state.xml -n`,
      stdinText: '',
    });

    expect(duplicateElse.stdout.text).toBe('');
    expect(duplicateElse.stderr.text).toBe('');
    expect(duplicateElse.result.exitCode).toBe(1);
    expect(elifAfterElse.stdout.text).toBe('');
    expect(elifAfterElse.stderr.text).toBe('');
    expect(elifAfterElse.result.exitCode).toBe(1);
    expect(actionAfterInput.stdout.text).toBe(`\
one
two`);
    expect(actionAfterInput.stderr.text).not.toBe('');
    expect(actionAfterInput.result.exitCode).toBe(3);
  });

  it('uses XMLStarlet quiet runtime-error exit status', async () => {
    await writeFile({ path: 'quiet-runtime.xml', data: '<root><item id="1"/></root>' });

    const undefinedNamespace = await execute({
      script: `xml sel -Q -t -v '/p:root' quiet-runtime.xml`,
      stdinText: '',
    });
    const attributeCopy = await execute({
      script: `xml sel -Q -t -c '/root/item/@id' quiet-runtime.xml`,
      stdinText: '',
    });
    const invalidSyntax = await execute({
      script: `xml sel -Q -t -v '//*[' quiet-runtime.xml`,
      stdinText: '',
    });

    expect(undefinedNamespace.stderr.text).not.toBe('');
    expect(undefinedNamespace.result.exitCode).toBe(1);
    expect(attributeCopy.stderr.text).not.toBe('');
    expect(attributeCopy.result.exitCode).toBe(1);
    expect(invalidSyntax.stderr.text).not.toBe('');
    expect(invalidSyntax.result.exitCode).toBe(4);
  });

  it('matches XMLStarlet mixed-content copy and document-order semantics', async () => {
    await writeFile({
      path: 'mixed-copy.xml',
      data: '<root><a>one<![CDATA[<two>]]>three<!--c--><?pi x?><b>four</b></a><group><item>g1</item></group><group><item>g2</item></group></root>',
    });

    const copied = await execute({
      script: `xml sel -t -c '/root/a/node()' mixed-copy.xml`,
      stdinText: '',
    });
    const ordered = await execute({
      script: `xml sel -T -t -m '//*' -v 'name()' -n -b mixed-copy.xml`,
      stdinText: '',
    });
    const attributeCopy = await execute({
      script: `xml sel -t -c '/root/a/@missing' mixed-copy.xml`,
      stdinText: '',
    });

    expect(copied.stdout.text).toBe('one&lt;two&gt;three<!--c--><?pi x?><b>four</b>');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect(ordered.stdout.text).toBe(`\
root
a
b
group
item
group
item
`);
    expect(ordered.stderr.text).toBe('');
    expect(ordered.result.exitCode).toBe(0);
    expect(attributeCopy.stdout.text).toBe('');
    expect(attributeCopy.stderr.text).toBe('');
    expect(attributeCopy.result.exitCode).toBe(1);
  });

  it('uses XPath sibling-axis order and wildcard predicates', async () => {
    await writeFile({
      path: 'xpath-siblings.xml',
      data: '<root><item id="1"/><item id="2"/><item id="3"/><other id="4"/></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -m '/root/item[2]' -v 'preceding-sibling::*[1]/@id' -o ':' -v 'following-sibling::*[1]/@id' -n xpath-siblings.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe('1:3\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses XPath Unicode substring and node-set comparison semantics', async () => {
    await writeFile({
      path: 'xpath-values.xml',
      data: '<root><item>alpha</item><item>beta</item><number>1</number><number>2</number><number>3</number></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v 'substring("😀éabc", 2, 3)' -n -i '/root/item = "beta"' -o yes --else -o no -b -n -i '/root/number > 2' -o greater --else -o smaller -b xpath-values.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
éab
yes
greater`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses XPath scalar coercion for conditional comparisons', async () => {
    await writeFile({
      path: 'xpath-scalar-values.xml',
      data: '<root/>',
    });

    const result = await execute({
      script: `xml sel -T -t -i 'true() = 1' -o true --else -o false -b -n -i 'false() = 0' -o true --else -o false -b -n -i 'true() != 2' -o true --else -o false -b -n -i "true() = 'false'" -o true --else -o false -b -n -i "string('01') = 1" -o true --else -o false -b -n -i "string('') = false()" -o true --else -o false -b xpath-scalar-values.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
true
true
false
true
true
true`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses the same XPath scalar coercion for values and conditions', async () => {
    await writeFile({
      path: 'xpath-scalar-output.xml',
      data: '<root/>',
    });

    const result = await execute({
      script: `xml sel -T -t -v "'+1' = 1" -n -v "'1e0' = 1" -n -v "string-length('😀') = 1" -n -v "'Infinity' = 1 div 0" -n -i "'1e0' = 1" -o true --else -o false -b xpath-scalar-output.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
false
true
true
false
true`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('matches XMLStarlet incomplete numeric lexical conversion', async () => {
    await writeFile({
      path: 'xpath-incomplete-numbers.xml',
      data: '<root/>',
    });

    const result = await execute({
      script: `xml sel -T -t -v "'1e' = 1" -n -v "'-' = 0" -n -v "number('-')" -n -v "number('+1')" -n -v "number('-') + 1" -n -v "string(number('-'))" -n -v "number ('-')" -n -v "number('-') + number('1e')" -n -v "-number('-')" -n -v "number('+1') = number('bad')" -n -i "'1e+' = 1" -o true --else -o false -b -n -i "' - ' = 0" -o true --else -o false -b xpath-incomplete-numbers.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
true
true
0
NaN
1
0
0
1
0
false
true
true`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses XMLStarlet numeric coercion in sum and substring functions', async () => {
    await writeFile({
      path: 'xpath-numeric-functions.xml',
      data: '<root><valid>1.5</valid><valid>2.5</valid><minus>-</minus><leading-plus>+1</leading-plus><start>1e</start><length>2e</length><huge>999999999999999999999</huge><huge>1</huge><overflow>1e309</overflow><overflow>1</overflow></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v 'sum(/root/minus)' -n -v 'sum(/root/leading-plus)' -n -v 'sum(/root/*[self::minus or self::valid])' -n -v 'substring("ABCDE", 0 div 0, 3)' -n -v 'substring("ABCDE", -1 div 0, 1 div 0)' -n -v 'substring("ABCDE", /root/start, /root/length)' -n -v 'substring("ABCDE", /root/minus, 2)' -n -v 'substring("ABCDE", /root/leading-plus, 2)' -n -v 'substring("😀éABC", /root/start, /root/length)' -n -v 'string-length(substring("ABCDE", /root/start, /root/length))' -n -v 'contains(substring("ABCDE", /root/start, /root/length), "AB")' -n -v 'sum(/root/overflow) > 0' -n -v 'boolean(sum(/root/huge))' -n -v 'sum(/root/huge) + 1' -n -v 'round(sum(/root/huge))' -n xpath-numeric-functions.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
0
NaN
4


AB
A

😀é
2
true
true
true
1e+21
1e+21
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves XPath predicate position and size after numeric filtering', async () => {
    await writeFile({
      path: 'xpath-numeric-predicate-context.xml',
      data: '<root><group id="a"><n>1e</n><n>2e+</n></group><group id="b"><n>+1</n></group><group id="c"><n>-</n><n>0</n></group><group id="d"><n>1e309</n></group><group id="e"><n>-1e309</n></group><group id="f"><n>999999999999999999999</n><n>1</n></group></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v '/root/group[sum(n) > 0][position() = 2]/@id' -n -v '/root/group[sum(n) > 0][last() = position()]/@id' -n -v '/root/group[sum(n) > 0 and @id != "f"]/@id' -n -v '/root/group[not(boolean(sum(n)))]/@id' -n -v '/root/group[n = 1]/@id' -n -v '/root/group[n > 0]/@id' -n xpath-numeric-predicate-context.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
d
f
a
d
b
c
a
f
a
d
f
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses XPath node-set pair comparison semantics', async () => {
    await writeFile({
      path: 'xpath-node-set-pairs.xml',
      data: '<root><case id="a"><l>1e</l><r>1</r></case><case id="e"><l>1</l><l>2</l><r>2</r><r>3</r></case><case id="i"><l>999999999999999999999</l><r>1e21</r></case></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v '/root/case[l = r]/@id' -n -v '/root/case[l != r]/@id' -n -v '/root/case[l[. > ../r]]/@id' -n xpath-node-set-pairs.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
e
a
e
i
i
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses XMLStarlet arithmetic coercion and document context', async () => {
    await writeFile({
      path: 'xpath-arithmetic-context.xml',
      data: '<root><n>1e</n><n-1>7</n-1><plus>+1</plus></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v 'n + 1' -n -v '/root/n + 1' -n -v '/root/n-1' -n -v '/root/n - 1' -n -v '1div2' -n -v '1and2' -n xpath-arithmetic-context.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
NaN
2
7
0
0.5
true
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves XPath arithmetic precedence and string coercion', async () => {
    const result = await execute({
      script: `xml sel -T -t -v "'2' + '2'" -n -v "'7' mod '4'" -n -v '1 - 2 - 3' -n -v '2 + 3 * 4' -n -`,
      stdinText: '<root/>',
    });

    expect(result.stdout.text).toBe(`\
4
3
-4
14
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('evaluates long XPath arithmetic chains without recursive rescanning', async () => {
    const operandCount = 20_000;
    const expression = Array.from({ length: operandCount }, () => '1').join(' + ');
    const result = await execute({
      script: `xml sel -T -t -v '${expression}' -`,
      stdinText: '<root/>',
    });

    expect(result.stdout.text).toBe(String(operandCount));
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps XPath operator names distinct from element names', async () => {
    await writeFile({
      path: 'xpath-operator-names.xml',
      data: '<root><and>1</and><or>2</or><div>4</div><mod>3</mod></root>',
    });

    const topLevel = await execute({
      script: `xml sel -T -t -v '/root/and + 1' -n -v '/root/or = 2' -n -v 'true() and /root/and' -n -v 'false() or /root/or' -n -v '/root/div + 1' -n -v '/root/mod mod 2' -n -v '8div-2' -n -v '7mod-4' -n -v '1e2div2' -n -v '1e-2mod.003' -n -v '(1and-2)' -n -v 'string(1e2)' -n -v 'not(0e0)' -n xpath-operator-names.xml`,
      stdinText: '',
    });
    expect(topLevel.stdout.text).toBe(`\
2
true
true
true
5
1
-4
3
50
0.001
true
100
true
`);
    expect(topLevel.stderr.text).toBe('');
    expect(topLevel.result.exitCode).toBe(0);

    const relative = await execute({
      script: `xml sel -T -t -m '/root' -v '1 + and[1]' -n -v 'or[1] = 2' -n -b xpath-operator-names.xml`,
      stdinText: '',
    });
    expect(relative.stdout.text).toBe(`\
2
true
`);
    expect(relative.stderr.text).toBe('');
    expect(relative.result.exitCode).toBe(0);
  });

  it('coerces XPath unions without falling back to DOM number conversion', async () => {
    await writeFile({
      path: 'xpath-union-coercion.xml',
      data: '<root xmlns:x="urn:test"><a id="a">1e</a><c>+1</c><c>1</c><x:e id="e">999999999999999999999</x:e></root>',
    });

    const result = await execute({
      script: `xml sel -T -N x=urn:test -t -v 'number(/root/x:e | /root/a)' -n -v 'sum(/root/x:e | /root/a)' -n -v 'count(/root/*[number(. | ../missing) = 1])' -n -v 'number((/root/x:e | /root/a)[1])' -n -v '(/root/x:e | /root/a)[position() <= 2]/@id' -n xpath-union-coercion.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
1
1e+21
2
1
a
e
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves scalar kinds through nested XPath parentheses', async () => {
    await writeFile({
      path: 'xpath-nested-parentheses.xml',
      data: '<root><a><item>1e</item><item>2</item></a><b><item>-</item><item>4</item></b></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v '((true()))' -n -v '((false()))' -n -v "(('abc'))" -n -v '((1 = 1))' -n -v '(((/root/a/item | /root/b/item)[1]))' -n -v 'number(((/root/a/item | /root/b/item)[1]))' -n xpath-nested-parentheses.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
true
false
abc
true
1e
1
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports XPath language and processing-instruction name semantics', async () => {
    await writeFile({
      path: 'xpath-language.xml',
      data: '<r:root xmlns:r="urn:root" xml:lang="en-US"><?target data?><group><child id="inherited"/></group><child id="french" xml:lang="fr"/></r:root>',
    });

    const result = await execute({
      script: `xml sel -T -N r=urn:root -t -v 'name(/r:root/processing-instruction()[1])' -n -v 'local-name(/r:root/processing-instruction()[1])' -n -v "count(/r:root//*[lang('en')])" -n -v "string(/r:root/group/child[lang('EN')]/@id)" -n -v "string(/r:root/child[lang('fr')]/@id)" -n -v 'count(/r:root//*[@xml:lang])' -n xpath-language.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
target
target
2
inherited
french
1
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses DTD and xml:id declarations for XPath id selection', async () => {
    await writeFile({
      path: 'xpath-id.xml',
      data: '<!DOCTYPE root [<!ATTLIST item key ID #REQUIRED><!ATTLIST defaulted ref ID "d">]><root><item key="a"/><item key="b"/><plain id="p"/><tagged xml:id="x"/><defaulted/><ids>b a</ids><ids>a</ids></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v "count(id('b a'))" -n -v "string(id('b a')[1]/@*)" -n -v 'count(id(/root/ids))' -n -v 'string(id(/root/ids)[last()]/@*)' -n -v "count(id('p'))" -n -v "name(id('a'))" -n -v "string(id('x')/@xml:id)" -n -v "string(id('d')/@ref)" -n xpath-id.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
2
b
2
a
0
item
x
d
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves XPath attribute context and reverse-axis predicate order', async () => {
    await writeFile({
      path: 'xpath-axis.xml',
      data: '<root><item id="a"><child>A</child></item><item id="b"><child>B</child></item><item id="c"><child>C</child></item></root>',
    });

    const result = await execute({
      script: `xml sel -T -t -v 'name(/root/item[1]/@id/..)' -n -v 'count(/root/item/@id/../child)' -n -v 'name(/root/item[1]/@id/ancestor::*[1])' -n -v 'name(/root/item[1]/@id/ancestor::*[last()])' -n -v 'name(/root/item[1]/@id/self::node())' -n -v 'string(/root/item[1]/@id/following::child[1])' -n -v 'name(/root/item[1]/child/ancestor::*[1])' -n -v 'string(/root/item[2]/child/preceding::child[1])' -n xpath-axis.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
item
3
item
root
id
B
item
A
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('excludes namespace declarations from XPath attribute axes', async () => {
    await writeFile({
      path: 'xpath-attributes.xml',
      data: '<root xmlns:p="urn:p" plain="r"><child xmlns:q="urn:q" p:flag="yes" plain="c"/></root>',
    });

    const result = await execute({
      script: `xml sel -T -N p=urn:p -t -v 'count(/root/@*)' -n -v 'count(/root/attribute::*)' -n -v 'name(/root/attribute::*[1])' -n -v 'count(/root/child/@*)' -n -v 'count(/root/child/attribute::*)' -n -v 'name(/root/child/attribute::*[1])' -n xpath-attributes.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
1
1
plain
2
2
p:flag
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports namespace wildcard name tests', async () => {
    await writeFile({
      path: 'xpath-namespace-wildcard.xml',
      data: '<root xmlns:p="urn:p" xmlns:q="urn:q" p:a="1" p:b="2" q:a="3"><p:item/><q:item/><p:group><p:leaf/></p:group></root>',
    });

    const result = await execute({
      script: `xml sel -T -N p=urn:p -N q=urn:q -t -v 'count(/root/@p:*)' -n -v 'name(/root/@p:*[1])' -n -v 'count(/root/attribute::q:*)' -n -v 'count(/root/p:*)' -n -v 'name(/root/p:*[last()])' -n -v 'count(/root/descendant::p:*)' -n xpath-namespace-wildcard.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
2
p:a
1
2
p:group
3
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('formats XPath numbers like XMLStarlet', async () => {
    await writeFile({
      path: 'xpath-number-format.xml',
      data: '<root/>',
    });

    const result = await execute({
      script: `xml sel -T -t -v "1 div 3" -n -v "10 div 3" -n -v "1 div 10000000" -n -v "100000000000000000000" -n -v "number('1e-6')" -n -v "number('-1e20')" -n -v "number('1e-5')" -n -v "number('9.99999999999999e+5')" -n -v "number('9.99999999999999e+8')" -n xpath-number-format.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
0.333333333333333
3.333333333333333
1e-07
1e+20
1e-06
-1e+20
0.00001
1000000
1000000000
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports match scopes, literal output, and nested break actions', async () => {
    await writeFile({
      path: 'books.xml',
      data: '<catalog><book id="b1"><title>Alpha</title></book><book id="b2"><title>Beta</title></book></catalog>',
    });

    const result = await execute({
      script: `xml sel -t -m '//book' -v '@id' -o ':' -m title -v . -b -n books.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
b1:Alpha
b2:Beta
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports namespace bindings and long template options', async () => {
    await writeFile({
      path: 'namespaced.xml',
      data: '<root xmlns="urn:test"><item id="a">One</item><item id="b">Two</item></root>',
    });

    const result = await execute({
      script: `xml sel -N x=urn:test --text --template --match '//x:item' --value-of '@id' --output '=' --value-of . --nl namespaced.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
a=One
b=Two
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves XPath descendant position semantics and mid-path descendant axes', async () => {
    await writeFile({
      path: 'structured.xml',
      data: '<r:root xmlns:r="urn:root" xmlns:x="urn:item"><x:group><x:item id="a"/><x:item id="b"/></x:group><x:group><x:item id="c"/><x:item id="d"/></x:group></r:root>',
    });

    const result = await execute({
      script: `xml sel -N r=urn:root -N x=urn:item -t -m '//x:item[1]' -v '@id' -n -b -m '/r:root//x:item[2]' -v '@id' -n structured.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
a
c
b
d
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports conditional branches within templates and match scopes', async () => {
    await writeFile({
      path: 'conditional.xml',
      data: '<root><item id="a"/><item id="b"/></root>',
    });

    const result = await execute({
      script: `xml sel -t -i 'count(//item)=0' -o zero --elif 'count(//item)=2' -o two --else -o other -b -n -m '//item' -i '@id="b"' -v '@id' -b -n conditional.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe(`\
two

b
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses XPath type conversion for conditional expressions', async () => {
    const result = await execute({
      script: `xml sel -t -i '"false"' -o string -b -i '0' -o zero -b -i '1' -o one -b -i 'boolean(/root/item)' -o node -b -`,
      stdinText: '<root><item/></root>',
    });

    expect(result.stdout.text).toBe('stringonenode');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('returns one when a valid template produces no output', async () => {
    const result = await execute({
      script: `xml sel -t -i 'false()' -o no -b -`,
      stdinText: '<root/>',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(1);
  });

  it('rejects conditional branch markers without an open if scope', async () => {
    const result = await execute({
      script: `xml sel -t --else -o no -b -`,
      stdinText: '<root/>',
    });

    expect(result.result.exitCode).toBe(2);
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain('xml sel: else without an open if branch');
  });

  it('supports quiet output while still evaluating the template', async () => {
    await writeFile({ path: 'value.xml', data: '<root><value>payload</value></root>' });

    const result = await execute({
      script: `xml sel --quiet -t -v '/root/value' -n value.xml`,
      stdinText: '',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('reports usage errors for missing template mode', async () => {
    const { result, stdout, stderr } = await execute({
      script: `xml sel -v '//book/title' -`,
      stdinText: '<catalog />',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xml sel: template mode (-t) is required');
    expect(stderr.text).toContain('usage: xml <command> [options] [args]');
    expect(result.exitCode).toBe(2);
  });

  it('uses XMLStarlet-compatible argument failure statuses', async () => {
    await writeFile({ path: 'valid.xml', data: '<root><value>ok</value></root>' });

    const missingValue = await execute({
      script: 'xml sel -t -v',
      stdinText: '',
    });
    const invalidNamespace = await execute({
      script: 'xml sel -N invalid -t -v / valid.xml',
      stdinText: '',
    });
    const unsupportedTerminator = await execute({
      script: 'xml sel -t -v / -- valid.xml',
      stdinText: '',
    });
    const unmatchedBreak = await execute({
      script: 'xml sel -t -b valid.xml',
      stdinText: '',
    });

    expect(missingValue.result.exitCode).toBe(2);
    expect(invalidNamespace.result.exitCode).toBe(2);
    expect(unsupportedTerminator.result.exitCode).toBe(2);
    expect(unmatchedBreak.result.exitCode).toBe(1);
    expect(missingValue.stderr.text).not.toBe('');
    expect(invalidNamespace.stderr.text).not.toBe('');
    expect(unsupportedTerminator.stderr.text).not.toBe('');
    expect(unmatchedBreak.stdout.text).toBe('');
    expect(unmatchedBreak.stderr.text).toBe('');
  });

  it('accepts an empty namespace URI binding', async () => {
    await writeFile({ path: 'plain.xml', data: '<root><value>ok</value></root>' });

    const result = await execute({
      script: `xml sel -N x= -t -v '/root/value' -n plain.xml`,
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('ok\n');
    expect(result.stderr.text).toBe('');
  });

  it('consumes repeated standard-input operands instead of replaying cached XML', async () => {
    const result = await execute({
      script: `xml sel -t -f -o ':' -v '/root/value' -n - -`,
      stdinText: '<root><value>once</value></root>',
    });

    expect(result.result.exitCode).toBe(3);
    expect(result.stdout.text).toBe('-:once\n');
    expect(result.stderr.text).toContain('xml sel: -:');
  });

  it('processes valid files around missing inputs without preloading all sources', async () => {
    await writeFile({ path: 'good.xml', data: '<root><value>good</value></root>' });

    const missingAfter = await execute({
      script: `xml sel -t -f -o ':' -v '/root/value' -n good.xml missing.xml`,
      stdinText: '',
    });
    const missingBefore = await execute({
      script: `xml sel -t -f -o ':' -v '/root/value' -n missing.xml good.xml`,
      stdinText: '',
    });

    expect(missingAfter.result.exitCode).toBe(3);
    expect(missingBefore.result.exitCode).toBe(3);
    expect(missingAfter.stdout.text).toBe('good.xml:good\n');
    expect(missingBefore.stdout.text).toBe(missingAfter.stdout.text);
    expect(missingAfter.stderr.text).toContain('xml sel: missing.xml:');
    expect(missingBefore.stderr.text).toContain('xml sel: missing.xml:');
  });

  it('continues across malformed inputs and returns the highest failure status', async () => {
    await writeFile({ path: 'good.xml', data: '<root><value>A &amp; B</value></root>' });
    await writeFile({ path: 'bad.xml', data: '<root>' });

    const result = await execute({
      script: `xml sel -t -f -o ':' -v '/root/value' -n bad.xml good.xml`,
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(3);
    expect(result.stdout.text).toBe('good.xml:A &amp; B\n');
    expect(result.stderr.text).toContain('xml sel: bad.xml:');
  });

  it('reports parse errors', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xml sel -t -v / -',
      stdinText: '<catalog>',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xml sel: -:');
    expect(result.exitCode).toBe(3);
  });
});
