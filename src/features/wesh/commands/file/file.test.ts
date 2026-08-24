import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh file', () => {
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
    data: Uint8Array | string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

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
    stdin = '',
  }: {
    script: string,
    stdin?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdin }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'file --help' });
    const missing = await execute({ script: 'file' });

    expect(help.stdout.text).toContain('Determine file type');
    expect(help.stdout.text).toContain('usage: file [-b] [-F SEPARATOR] [-i] [-L] [--brief] [--mime] [--mime-type] [--mime-encoding] [--help] FILE...');
    expect(help.stdout.text).toContain('--brief');
    expect(help.stdout.text).toContain('--mime');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stderr.text).toContain('file: missing file operand');
    expect(missing.stderr.text).toContain('usage: file [-b] [-F SEPARATOR] [-i] [-L] [--brief] [--mime] [--mime-type] [--mime-encoding] [--help] FILE...');
    expect(missing.result.exitCode).toBe(1);
  });

  it('lets a later help option win over earlier unknown-option diagnostics', async () => {
    const unknownThenHelp = await execute({ script: 'file --definitely-invalid-option --help' });
    const invalidValueThenHelp = await execute({ script: 'file -F --help' });

    expect(unknownThenHelp.stdout.text).toContain('Determine file type');
    expect(unknownThenHelp.stderr.text).toContain("file: unrecognized option '--definitely-invalid-option'");
    expect(unknownThenHelp.result.exitCode).toBe(0);

    expect(invalidValueThenHelp.stdout.text).toBe('');
    expect(invalidValueThenHelp.stderr.text).not.toBe('');
    expect(invalidValueThenHelp.result.exitCode).not.toBe(0);
  });

  it('classifies directories and symlinks', async () => {
    await rootHandle.getDirectoryHandle('docs', { create: true });
    await writeFile({
      path: '/target.txt',
      data: 'hello\n',
    });
    await wesh.vfs.symlink({
      path: '/link.txt',
      targetPath: '/target.txt',
    });

    const directory = await execute({ script: 'file /docs' });
    expect(directory.stdout.text).toBe('/docs: directory\n');
    expect(directory.stderr.text).toBe('');
    expect(directory.result.exitCode).toBe(0);

    const symlink = await execute({ script: 'file /link.txt' });
    expect(symlink.stdout.text).toBe('/link.txt: symbolic link to /target.txt\n');
    expect(symlink.stderr.text).toBe('');
    expect(symlink.result.exitCode).toBe(0);
  });

  it('supports custom filename separators with last-one-wins semantics', async () => {
    await writeFile({ path: '/a', data: 'alpha\n' });
    await writeFile({ path: '/longname', data: 'beta\n' });

    const short = await execute({ script: "file -F: -F, /a /longname" });
    const long = await execute({ script: "file --separator=: --separator='::' /a /longname" });
    const empty = await execute({ script: "file -F '' /a /longname" });
    const brief = await execute({ script: "file -b -F, /a /longname" });

    expect(short.stdout.text).toBe(`\
/a,        ASCII text
/longname, ASCII text
`);
    expect(long.stdout.text).toBe(`\
/a::        ASCII text
/longname:: ASCII text
`);
    expect(empty.stdout.text).toBe(`\
/a        ASCII text
/longname ASCII text
`);
    expect(brief.stdout.text).toBe(`\
ASCII text
ASCII text
`);
    for (const execution of [short, long, empty, brief]) {
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('follows symbolic links with -L', async () => {
    await writeFile({ path: '/target.txt', data: 'hello\n' });
    await wesh.vfs.symlink({ path: '/link.txt', targetPath: '/target.txt' });

    const result = await execute({ script: 'file -L /link.txt' });

    expect(result.stdout.text).toBe('/link.txt: ASCII text\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('classifies empty, JSON, shell script, and UTF-8 text files', async () => {
    await writeFile({
      path: '/empty.txt',
      data: '',
    });
    await writeFile({
      path: '/data.json',
      data: '{"name":"alice"}\n',
    });
    await writeFile({
      path: '/script.sh',
      data: `\
#!/bin/sh
echo hello
`,
    });
    await writeFile({
      path: '/utf8.txt',
      data: 'こんにちは\n',
    });
    await writeFile({
      path: '/utf16.txt',
      data: Uint8Array.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00, 0x0A, 0x00]),
    });

    const result = await execute({
      script: 'file /empty.txt /data.json /script.sh /utf8.txt /utf16.txt',
    });

    expect(result.stdout.text).toBe(`\
/empty.txt: empty
/data.json: JSON text data
/script.sh: POSIX shell script, ASCII text executable
/utf8.txt:  Unicode text, UTF-8 text
/utf16.txt: Unicode text, UTF-16, little-endian text
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('recognizes a shell script only when the shebang starts the file', async () => {
    await writeFile({ path: '/direct.sh', data: `\
#!/bin/sh
echo ok
` });
    await writeFile({ path: '/bom.sh', data: '\uFEFF#!/bin/sh\necho ok\n' });
    await writeFile({ path: '/space.sh', data: `\
 #!/bin/sh
echo ok
` });
    await writeFile({ path: '/tab.sh', data: '\t#!/bin/sh\necho ok\n' });
    await writeFile({ path: '/newline.sh', data: `\

#!/bin/sh
echo ok
` });
    await writeFile({ path: '/nbsp.sh', data: '\u00A0#!/bin/sh\necho ok\n' });
    await writeFile({ path: '/em-space.sh', data: '\u2003#!/bin/sh\necho ok\n' });

    const result = await execute({
      script: 'file -b /direct.sh /bom.sh /space.sh /tab.sh /newline.sh /nbsp.sh /em-space.sh',
    });

    expect(result.stdout.text).toBe(`\
POSIX shell script, ASCII text executable
POSIX shell script, Unicode text, UTF-8 (with BOM) text executable
ASCII text
ASCII text
ASCII text
Unicode text, UTF-8 text
Unicode text, UTF-8 text
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('classifies only the shebang interpreter and ignores language names in the body', async () => {
    const fixtures = [
      ['sh', `\
#!/bin/sh
echo ok
`],
      ['bash', `\
#!/usr/bin/env bash
echo ok
`],
      ['python', `\
#!/usr/bin/python
print("sh")
`],
      ['env-python', `\
#!/usr/bin/env python3
# sh marker
print(1)
`],
      ['node', `\
#!/usr/bin/node
const sh = 1;
`],
      ['env-node', `\
#!/usr/bin/env node
console.log("bash")
`],
    ] as const;
    for (const [name, data] of fixtures) {
      await writeFile({ path: `/${name}`, data });
    }

    const descriptions = await execute({
      script: `file -b ${fixtures.map(([name]) => `/${name}`).join(' ')}`,
    });
    const mimeTypes = await execute({
      script: `file -b --mime-type ${fixtures.map(([name]) => `/${name}`).join(' ')}`,
    });

    expect(descriptions.stdout.text).toBe(`\
POSIX shell script, ASCII text executable
Bourne-Again shell script, ASCII text executable
Python script, ASCII text executable
Python script, ASCII text executable
Node.js script executable, ASCII text
Node.js script executable, ASCII text
`);
    expect(mimeTypes.stdout.text).toBe(`\
text/x-shellscript
text/x-shellscript
text/x-script.python
text/x-script.python
application/javascript
application/javascript
`);
    expect(descriptions.stderr.text).toBe('');
    expect(mimeTypes.stderr.text).toBe('');
    expect(descriptions.result.exitCode).toBe(0);
    expect(mimeTypes.result.exitCode).toBe(0);
  });

  it('classifies ASCII controls, line terminators, and single-byte text encodings', async () => {
    const fixtures = [
      ['escape', Uint8Array.from([0x1B, 0x5B, 0x33, 0x31, 0x6D, 0x72, 0x65, 0x64, 0x1B, 0x5B, 0x30, 0x6D, 0x0A])],
      ['backspace', Uint8Array.from([0x61, 0x62, 0x08, 0x63, 0x64, 0x0A])],
      ['cr', Uint8Array.from([0x61, 0x0D, 0x62, 0x0D])],
      ['mixed', Uint8Array.from([0x61, 0x0D, 0x62, 0x0A])],
      ['delete', Uint8Array.from([0x61, 0x7F, 0x62, 0x0A])],
      ['unknown-8bit', Uint8Array.from([0x61, 0x80, 0x62, 0x0A])],
      ['iso-8859', Uint8Array.from([0x61, 0xA0, 0x62, 0x0A])],
      ['nel', Uint8Array.from([0x61, 0x85, 0x62, 0x0A])],
    ] as const;
    for (const [name, data] of fixtures) {
      await writeFile({ path: `/${name}`, data });
    }

    const descriptions = await execute({
      script: `file -b ${fixtures.map(([name]) => `/${name}`).join(' ')}`,
    });
    const mime = await execute({
      script: `file -b -i ${fixtures.map(([name]) => `/${name}`).join(' ')}`,
    });

    expect(descriptions.stdout.text).toBe(`\
ASCII text, with escape sequences
ASCII text, with overstriking
ASCII text, with CR line terminators
ASCII text, with CR, LF line terminators
data
Non-ISO extended-ASCII text
ISO-8859 text
ASCII text, with LF, NEL line terminators
`);
    expect(mime.stdout.text).toBe(`\
text/plain; charset=us-ascii
text/plain; charset=us-ascii
text/plain; charset=us-ascii
text/plain; charset=us-ascii
application/octet-stream; charset=binary
text/plain; charset=unknown-8bit
text/plain; charset=iso-8859-1
text/plain; charset=us-ascii
`);
    expect(descriptions.stderr.text).toBe('');
    expect(mime.stderr.text).toBe('');
    expect(descriptions.result.exitCode).toBe(0);
    expect(mime.result.exitCode).toBe(0);
  });

  it('requires XML and SVG markers at the beginning after an optional BOM', async () => {
    await writeFile({ path: '/xml.xml', data: '<?xml version="1.0"?><root/>' });
    await writeFile({ path: '/xml-bom.xml', data: '\uFEFF<?xml version="1.0"?><root/>' });
    await writeFile({ path: '/xml-space.xml', data: ' <?xml version="1.0"?><root/>' });
    await writeFile({ path: '/xml-nbsp.xml', data: '\u00A0<?xml version="1.0"?><root/>' });
    await writeFile({ path: '/svg.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    await writeFile({ path: '/svg-bom.svg', data: '\uFEFF<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    await writeFile({ path: '/svg-newline.svg', data: '\n<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    await writeFile({ path: '/root.xml', data: '<root/>' });
    await writeFile({ path: '/html-nbsp.html', data: '\u00A0<html><body>x</body></html>' });

    const result = await execute({
      script: `\
file -b --mime-type \
  /xml.xml /xml-bom.xml /xml-space.xml /xml-nbsp.xml \
  /svg.svg /svg-bom.svg /svg-newline.svg /root.xml /html-nbsp.html`,
    });

    expect(result.stdout.text).toBe(`\
text/xml
text/xml
text/plain
text/plain
image/svg+xml
image/svg+xml
text/plain
text/plain
text/html
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('classifies binary formats and supports brief output', async () => {
    await writeFile({
      path: '/image.png',
      data: Uint8Array.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
        0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
        0x42, 0x60, 0x82,
      ]),
    });

    const result = await execute({
      script: 'file -b /image.png',
    });

    expect(result.stdout.text).toContain('image/png');
    expect(result.stdout.text).toContain('(png)');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports MIME output', async () => {
    await writeFile({
      path: '/data.json',
      data: '{"ok":true}\n',
    });

    const textMime = await execute({
      script: 'file -i /data.json',
    });

    expect(textMime.stdout.text).toBe('/data.json: application/json; charset=us-ascii\n');
    expect(textMime.stderr.text).toBe('');
    expect(textMime.result.exitCode).toBe(0);

    const plainTextMime = await execute({
      script: `\
printf 'alpha
' > /plain.txt; file -i /plain.txt`,
    });
    expect(plainTextMime.stdout.text).toBe('/plain.txt: text/plain; charset=us-ascii\n');
    expect(plainTextMime.stderr.text).toBe('');
    expect(plainTextMime.result.exitCode).toBe(0);

    const directoryMime = await execute({
      script: 'file --mime-type /',
    });

    expect(directoryMime.stdout.text).toBe('/: inode/directory\n');
    expect(directoryMime.stderr.text).toBe('');
    expect(directoryMime.result.exitCode).toBe(0);
  });


  it('separates MIME type and encoding output', async () => {
    await writeFile({ path: '/plain.txt', data: 'alpha\n' });

    const type = await execute({ script: 'file --mime-type /plain.txt' });
    const encoding = await execute({ script: 'file --mime-encoding /plain.txt' });
    const combined = await execute({
      script: 'file --mime-type --mime-encoding /plain.txt',
    });

    expect(type.stdout.text).toBe('/plain.txt: text/plain\n');
    expect(encoding.stdout.text).toBe('/plain.txt: us-ascii\n');
    expect(combined.stdout.text).toBe('/plain.txt: text/plain; charset=us-ascii\n');
    expect(type.result.exitCode).toBe(0);
    expect(encoding.result.exitCode).toBe(0);
    expect(combined.result.exitCode).toBe(0);
  });

  it('classifies standard input and consumes repeated operands sequentially', async () => {
    const once = await execute({
      script: 'file --mime-type -',
      stdin: 'alpha\n',
    });
    const repeated = await execute({
      script: 'file - -',
      stdin: 'alpha\n',
    });

    expect(once.stdout.text).toBe('/dev/stdin: text/plain\n');
    expect(once.stderr.text).toBe('');
    expect(once.result.exitCode).toBe(0);
    expect(repeated.stdout.text).toBe(`\
/dev/stdin: ASCII text
/dev/stdin: empty
`);
    expect(repeated.stderr.text).toBe('');
    expect(repeated.result.exitCode).toBe(0);
  });

  it('distinguishes broken symlinks and text byte order', async () => {
    await wesh.vfs.symlink({ path: '/broken', targetPath: '/missing' });
    await writeFile({
      path: '/bom.txt',
      data: Uint8Array.from([0xEF, 0xBB, 0xBF, 0x61, 0x0A]),
    });
    await writeFile({
      path: '/utf16be.txt',
      data: Uint8Array.from([0xFE, 0xFF, 0x00, 0x61, 0x00, 0x0A]),
    });

    const result = await execute({
      script: 'file /broken /bom.txt /utf16be.txt',
    });

    expect(result.stdout.text).toBe(`\
/broken:      broken symbolic link to /missing
/bom.txt:     Unicode text, UTF-8 (with BOM) text
/utf16be.txt: Unicode text, UTF-16, big-endian text
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('reports missing files and continues', async () => {
    await writeFile({
      path: '/exists.txt',
      data: 'plain text\n',
    });

    const result = await execute({
      script: 'file /exists.txt /missing.txt',
    });

    expect(result.stdout.text).toBe(`\
/exists.txt:  ASCII text
/missing.txt: cannot open \`/missing.txt' (No such file or directory)
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('reports an XML version only for the exact declaration prefix', async () => {
    const fixtures = [
      ['one-space.xml', '<?xml version="1.0"?><root/>'],
      ['single-quote.xml', "<?xml version='1.1'?><root/>"],
      ['two-spaces.xml', '<?xml  version="1.0"?><root/>'],
      ['tab.xml', '<?xml\tversion="1.0"?><root/>'],
      ['newline.xml', `\
<?xml
version="1.0"?><root/>`],
      ['nbsp.xml', '<?xml\u00A0version="1.0"?><root/>'],
      ['later.xml', '<?xml foo="x" version="1.0"?><root/>'],
      ['upper.xml', '<?XML version="1.0"?><root/>'],
    ] as const;
    for (const [path, data] of fixtures) {
      await writeFile({ path: `/${path}`, data });
    }

    const result = await execute({
      script: `file -b ${fixtures.map(([path]) => `/${path}`).join(' ')}`,
    });

    const lines = result.stdout.text.split('\n');
    expect(lines[0]).toContain('XML 1.0 document');
    expect(lines[1]).toContain('XML 1.1 document');
    for (const line of lines.slice(2, fixtures.length)) {
      expect(line).toContain('XML document');
      expect(line).not.toMatch(/XML [0-9]/u);
    }
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });


  it('distinguishes named and standard-input empty MIME types', async () => {
    await writeFile({ path: '/empty', data: '' });

    const type = await execute({
      script: 'file --mime-type /empty - -',
      stdin: '',
    });
    const combined = await execute({
      script: 'file -bi /empty -',
      stdin: '',
    });

    expect(type.stdout.text).toBe(`\
/empty: inode/x-empty
/dev/stdin:      application/x-empty
/dev/stdin:      application/x-empty
`);
    expect(combined.stdout.text).toBe(`\
inode/x-empty; charset=binary
application/x-empty; charset=binary
`);
    expect(type.stderr.text).toBe('');
    expect(combined.stderr.text).toBe('');
    expect(type.result.exitCode).toBe(0);
    expect(combined.result.exitCode).toBe(0);
  });

  it('matches broken-symlink MIME output and encoding failure', async () => {
    await wesh.vfs.symlink({ path: '/broken', targetPath: '/missing' });

    const combined = await execute({ script: 'file -i /broken' });
    const encoding = await execute({ script: 'file --mime-encoding /broken' });

    expect(combined.stdout.text).toBe('/broken: inode/symlink\n');
    expect(combined.stderr.text).toBe('');
    expect(combined.result.exitCode).toBe(0);
    expect(encoding.stdout.text).toBe('/broken: ERROR: (null)\n');
    expect(encoding.stderr.text).toBe('');
    expect(encoding.result.exitCode).toBe(1);
  });

  it('aligns standard-input display names using the original operand width', async () => {
    await writeFile({ path: '/a', data: 'alpha\n' });
    await writeFile({ path: '/empty', data: '' });

    const result = await execute({
      script: 'cd /; file a - empty',
      stdin: 'stdin text\n',
    });

    expect(result.stdout.text).toBe(`\
a:     ASCII text
/dev/stdin:     ASCII text
empty: empty
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });


  it('uses terminal display width when aligning Unicode operands', async () => {
    await writeFile({ path: '/a', data: 'alpha\n' });
    await writeFile({ path: '/é', data: 'alpha\n' });
    await writeFile({ path: '/日本', data: 'alpha\n' });
    await writeFile({ path: '/🙂', data: 'alpha\n' });
    await writeFile({ path: '/é', data: 'alpha\n' });

    const result = await execute({
      script: "cd /; file a é 日本 '🙂' 'é'",
    });

    expect(result.stdout.text).toBe(`\
a:    ASCII text
é:    ASCII text
日本: ASCII text
🙂:   ASCII text
é:   ASCII text
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

});
