import { describe, it, expect, beforeEach } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';
import {
  createReadHandleFromStream,
  createWriteHandleFromStream,
} from './utils/stream';

describe('Wesh Shell', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as any });
    await wesh.init();

    wesh.registerCommand({
      definition: {
        meta: { name: 'true', description: 'Success', usage: 'true' },
        fn: async () => ({ exitCode: 0 })
      }
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'false', description: 'Fail', usage: 'false' },
        fn: async () => ({ exitCode: 1 })
      }
    });
  });

  it('executes simple commands', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo hello', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello');
    expect(result.exitCode).toBe(0);
  });

  it('handles variable assignment', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'MYVAR=test', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createTestWriteCaptureHandle();
    const result = await wesh.execute({ script: 'echo $MYVAR', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('test');
    expect(result.exitCode).toBe(0);
  });

  it('handles sequential commands with ;', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo A; echo B', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
    expect(result.exitCode).toBe(0);
  });

  it('handles logical AND (&&)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo A && echo B', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
    expect(result.exitCode).toBe(0);

    const stdout2 = createTestWriteCaptureHandle();
    const resultFail = await wesh.execute({ script: 'false && echo B', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(resultFail.exitCode).not.toBe(0);
    expect(stdout2.text).not.toContain('B');
  });

  it('handles if statements', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'if true; then echo yes; else echo no; fi', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('yes');

    const stdout2 = createTestWriteCaptureHandle();
    await wesh.execute({ script: 'if false; then echo yes; else echo no; fi', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('no');
  });

  it('handles for loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'for i in A B; do echo $i; done', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
  });

  it('handles while loops and break', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
i=0
while true; do
  echo $i
  i=$((i + 1))
  if [[ $i == 3 ]]; then
    break
  fi
done`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
0
1
2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles until loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
i=0
until [[ $i == 3 ]]; do
  echo $i
  i=$((i + 1))
done`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
0
1
2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles continue inside loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
for item in a skip b; do
  if [[ $item == skip ]]; then
    continue
  fi
  echo $item
done`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
a
b
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports nested break and continue levels', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
for outer in 1 2; do
  for inner in a skip stop z; do
    if [[ $inner == skip ]]; then
      continue
    fi
    if [[ $inner == stop ]]; then
      break 2
    fi
    echo "$outer:$inner"
  done
done`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('1:a\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports continue levels across nested loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
for outer in 1 2; do
  for inner in keep skip done; do
    if [[ $inner == skip ]]; then
      continue 2
    fi
    echo "$outer:$inner"
  done
done`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
1:keep
2:keep
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports break outside loops as an error', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: 'break 2',
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('break');
    expect(result.exitCode).toBe(1);
  });

  it('keeps loop state changes isolated inside pipeline stages', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
printf 'a\nb\n' | while read line; do
  seen=$line
done
echo "$seen"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('updates parent shell state for redirected while loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
while read line; do
  seen=$line
done <<EOF
alpha
EOF
echo "$seen"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('streams while loop output before stdin closes', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined = undefined;
    let resolveFirstWrite: (() => void) | undefined = undefined;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const outputChunks: string[] = [];

    const stdin = createReadHandleFromStream({
      source: new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
          nextController.enqueue(encoder.encode('alpha\n'));
        },
      }),
    });
    const stdout = createWriteHandleFromStream({
      target: new WritableStream<Uint8Array>({
        write(chunk) {
          outputChunks.push(decoder.decode(chunk, { stream: true }));
          resolveFirstWrite?.();
          resolveFirstWrite = undefined;
        },
        close() {
          outputChunks.push(decoder.decode());
        },
      }),
    });
    const stderr = createTestWriteCaptureHandle();

    const resultPromise = wesh.execute({
      script: `\
while read line; do
  echo "<$line>"
done`,
      stdin,
      stdout,
      stderr: stderr.handle,
    });

    await firstWrite;
    expect(outputChunks.join('')).toContain('<alpha>');

    expect(controller).toBeDefined();
    controller!.enqueue(encoder.encode('beta\n'));
    controller!.close();

    const result = await resultPromise;
    expect(outputChunks.join('')).toBe('<alpha>\n<beta>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports shell functions and return', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
greet() {
  echo "hello $1"
  return 7
}
greet world
echo $?`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
hello world
7
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports function keyword syntax and current-shell mutation', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
function set_value {
  VALUE=inside
}
set_value
echo "$VALUE"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('inside\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports function keyword with parentheses syntax', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
function greet() {
  echo "hello $1"
}
greet world`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('hello world\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps function state changes isolated inside pipeline stages', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
set_value() {
  VALUE=inside
}
set_value | cat
echo "$VALUE"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports return outside a shell function as an error', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: 'return 4',
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('return');
    expect(result.exitCode).toBe(1);
  });

  it('uses the last command status for return without an explicit code', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
propagate() {
  false
  return
}
propagate
echo $?`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('stops executing the rest of a function body after return', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
early() {
  echo before
  return 4
  echo after
}
early
echo $?`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
before
4
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('propagates break from shell functions to surrounding loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
stop_loop() {
  break
}
for item in one two; do
  echo "start:$item"
  stop_loop
  echo "after:$item"
done`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('start:one\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('propagates continue from shell functions to surrounding loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
skip_rest() {
  continue
}
for item in one two; do
  echo "start:$item"
  skip_rest
  echo "after:$item"
done`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
start:one
start:two
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles case statements', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
value=beta
case "$value" in
  alpha)
    echo first
    ;;
  beta|gamma)
    echo second
    ;;
  *)
    echo fallback
    ;;
esac`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('second\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles case wildcard fallbacks', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
value=delta
case "$value" in
  alpha)
    echo first
    ;;
  beta|gamma)
    echo second
    ;;
  *)
    echo fallback
    ;;
esac`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('fallback\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles command substitution and trims trailing newlines', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
value=$(printf 'one\ntwo\n\n')
echo "<$value>"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('<one\ntwo>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('distinguishes quoted and unquoted command substitution field splitting', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
show_args() {
  echo "$#:$1:$2"
}
show_args $(printf 'one two')
show_args "$(printf 'one two')"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
2:one:two
1:one two:
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports nested command substitution', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
echo "$(printf '%s' "$(printf inner)")"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('inner\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps command substitution shell state isolated from the parent shell', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
VAR=parent
value=$(VAR=child; helper() { echo nested; }; echo "$VAR")
echo "$value"
echo "$VAR"
helper`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
child
parent
`);
    expect(stderr.text).toContain('Command not found');
    expect(result.exitCode).toBe(1);
  });

  it('supports [[ ]] conditionals', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
value=alphabet
if [[ -n $value && $value == alpha* ]]; then
  echo match
fi`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('match\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports [[ ]] negation and grouped boolean logic', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
value=alphabet
if [[ ! -z $value && ($value == alpha* || $value == beta*) ]]; then
  echo grouped
fi`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('grouped\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports arithmetic commands with side effects', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
i=1
((i++))
echo "$i"
((i == 2))
echo $?`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
2
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports arithmetic conditions in while loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
i=0
while ((i < 3)); do
  echo "$i"
  ((i += 1))
done`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
0
1
2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports parameter default, assignment, alternate, and pattern removal expansions', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
unset MISSING
value=alphabet-suffix
echo "\${MISSING:-fallback}"
echo "\${MISSING:=assigned}"
echo "$MISSING"
echo "\${value:+alt}"
echo "\${value#alpha}"
echo "\${value%suffix}"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
fallback
assigned
assigned
alt
bet-suffix
alphabet-
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports brace expansion while leaving quoted braces literal', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
echo pre{a,b}post
echo "{a,b}"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
preapost prebpost
{a,b}
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats quoted here-doc delimiters as literal content', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
value=expanded
cat <<EOF
$value
EOF
cat <<'EOF'
$value
EOF`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
expanded
$value
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports file redirection and reading (Mock OPFS)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'echo "file content" > test.txt', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const handle = await rootHandle.getFileHandle('test.txt');
    const file = await handle.getFile();
    const text = await file.text();
    expect(text).toContain('file content');

    const stdout2 = createTestWriteCaptureHandle();
    const catResult = await wesh.execute({ script: 'cat test.txt', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('file content');
    expect(catResult.exitCode).toBe(0);
  });

  it('supports process substitution as redirected while-loop input in the parent shell', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
while read line; do
  seen=$line
done < <(printf 'alpha\nbeta\n')
echo "$seen"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('beta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports output process substitution in redirections', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
cat > >(cat > captured.txt) <<EOF
alpha
beta
EOF`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    const handle = await rootHandle.getFileHandle('captured.txt');
    const file = await handle.getFile();

    expect(await file.text()).toBe(`\
alpha
beta
`);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports case inside shell functions', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
describe_value() {
  case "$1" in
    alpha) echo first ;;
    beta) echo second ;;
    *) echo other ;;
  esac
}
describe_value beta`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('second\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps trap changes made in shell functions in the current shell', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
install_trap() {
  trap -- 'echo from-function' EXIT
}
install_trap
trap -p`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toContain(`trap -- 'echo from-function' EXIT`);
    expect(stdout.text).toContain('from-function');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports combined stdin and stdout redirection on compound while commands', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
while read line; do
  echo "item:$line"
done > loop.txt <<EOF
alpha
beta
EOF
cat loop.txt`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
item:alpha
item:beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('combines redirected while loops with case, arithmetic, and command substitution', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
total=0
while read line; do
  case "$line" in
    add:*)
      value=\${line#add:}
      ((total += value))
      ;;
    emit)
      echo "$(printf 'sum=%s' "$total")"
      ;;
  esac
done <<EOF
add:2
add:3
emit
EOF
echo "$total"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
sum=5
5
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('combines shell functions with while, case, and pipeline isolation', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
summarize() {
  total=0
  while read line; do
    case "$line" in
      add:*)
        value=\${line#add:}
        ((total += value))
        ;;
      emit)
        echo "$(printf 'sum=%s' "$total")"
        ;;
    esac
  done
}
printf 'add:2\nadd:3\nemit\n' | summarize
echo "$total"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
sum=5

`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles subshells ( isolation )', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'VAR=parent', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createTestWriteCaptureHandle();
    await wesh.execute({ script: '(VAR=child; echo $VAR); echo $VAR', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('child');
    expect(stdout2.text).toContain('parent');

    // Check that child assignment didn't leak
    const stdout3 = createTestWriteCaptureHandle();
    await wesh.execute({ script: 'echo $VAR', stdin, stdout: stdout3.handle, stderr: stderr.handle });
    expect(stdout3.text).toBe('parent\n');
  });

  it('keeps function definitions created in subshells isolated from the parent shell', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
(tempfn() { echo child; })
tempfn`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('Command not found');
    expect(result.exitCode).toBe(1);
  });

  it('handles here-documents (<<EOF)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'cat <<EOF\nhello\nworld\nEOF', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello');
    expect(stdout.text).toContain('world');
  });

  it('handles here-strings (<<<)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'cat <<< "hello world"', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello world');
  });

  it('handles process substitution <(cmd)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'cat <(echo "subst")', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('subst');
  });

  it('handles environment variable maps ( Map compliance )', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'export TEST_MAP=1', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createTestWriteCaptureHandle();
    await wesh.execute({ script: 'env', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('TEST_MAP=1');
  });

  it('treats a broken pipeline writer like SIGPIPE instead of a shell error', async () => {
    const handle = await rootHandle.getFileHandle('large.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write(`first\n${'x'.repeat(131072)}`);
    await writable.close();

    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: 'cat large.txt | head -n 1',
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('first\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not leak pipeline builtin state changes back to the parent shell', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
echo value | read PIPE_VALUE
echo "$PIPE_VALUE"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('runs pipeline commands in distinct processes that share a process group', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const seenProcesses: Array<{ pid: number; pgid: number }> = [];

    wesh.registerCommand({
      definition: {
        meta: {
          name: 'capture-proc',
          description: 'Capture process identity for testing',
          usage: 'capture-proc',
        },
        fn: async ({ context }) => {
          seenProcesses.push({
            pid: context.process.getPid(),
            pgid: context.process.getGroupId(),
          });
          return { exitCode: 0 };
        },
      },
    });

    const result = await wesh.execute({
      script: 'capture-proc | capture-proc',
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(seenProcesses).toHaveLength(2);
    expect(seenProcesses[0]!.pid).not.toBe(seenProcesses[1]!.pid);
    expect(seenProcesses[0]!.pgid).toBe(seenProcesses[1]!.pgid);
    const processGroup = wesh.kernel.getProcessesByGroup({ pgid: seenProcesses[0]!.pgid });
    expect(processGroup.some(proc => proc.pid === seenProcesses[0]!.pid)).toBe(true);
    expect(processGroup.some(proc => proc.pid === seenProcesses[1]!.pid)).toBe(true);
  });

  it('stores traps in the current shell and lists them', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo bye' EXIT
trap -p`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`trap -- 'echo bye' EXIT`);
  });

  it('keeps trap changes in subshells isolated from the parent shell', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo parent' EXIT
(trap -- 'echo child' EXIT; trap -p)
trap -p`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`trap -- 'echo child' EXIT`);
    expect(stdout.text).toContain(`trap -- 'echo parent' EXIT`);
  });

  it('runs EXIT traps when the shell finishes', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo exit-trap' EXIT
echo body`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
body
exit-trap
`);
  });

  it('preserves $? while EXIT traps run', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo $? >&2' EXIT
false`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
1
`);
  });

  it('runs subshell EXIT traps without overwriting the parent trap', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo parent-exit' EXIT
(trap -- 'echo child-exit' EXIT)
echo body`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
child-exit
body
parent-exit
`);
  });

  it('runs PIPE traps when a pipeline writer gets SIGPIPE', async () => {
    const handle = await rootHandle.getFileHandle('large.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write(`first\n${'x'.repeat(131072)}`);
    await writable.close();

    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo pipe-trap >&2' PIPE
cat large.txt | head -n 1`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
first
`);
    expect(stderr.text).toBe(`\
pipe-trap
`);
  });

  it('preserves $? while signal traps run', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    wesh.registerCommand({
      definition: {
        meta: {
          name: 'signal-pipe',
          description: 'Send SIGPIPE to the current process',
          usage: 'signal-pipe',
        },
        fn: async ({ context }) => {
          await context.process.signalSelf({
            signal: 13,
          });
          return { exitCode: 0 };
        },
      },
    });

    const result = await wesh.execute({
      script: `\
trap -- 'echo $? >&2' PIPE
signal-pipe`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 13,
    });
    expect(result.exitCode).toBe(141);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
141
`);
  });

  it('runs INT traps when a command signals its foreground process group', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    wesh.registerCommand({
      definition: {
        meta: {
          name: 'signal-int',
          description: 'Send SIGINT to the current process group',
          usage: 'signal-int',
        },
        fn: async ({ context }) => {
          await context.process.signalGroup({
            signal: 2,
          });
          throw new Error('foreground process group interrupted');
        },
      },
    });

    const result = await wesh.execute({
      script: `\
trap -- 'echo int-trap >&2' INT
signal-int`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
int-trap
`);
  });

  it('signals the foreground process group through the shell API', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: `\
trap -- 'echo shell-int >&2' INT
sleep 1`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
shell-int
`);
  });

  it('ignores foreground SIGINT when trap disposition is ignore', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: `\
trap -- '' INT
sleep 0.05`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'exited',
      exitCode: 0,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
  });

  it('does not mark the top-level shell process as signaled when interrupting the foreground group', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: `\
sleep 1`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    await wesh.signalForegroundProcessGroup({ signal: 2 });
    await execution;

    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;
    expect(wesh.kernel.getWaitStatus({ pid: shellPid })).toBeUndefined();
  });

  it('signals the foreground pipeline process group through the shell API', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: `\
trap -- 'echo pipeline-int >&2' INT
sleep 1 | cat`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('pipeline-int\n');
  });

  it('interrupts commands blocked on input reads', async () => {
    const { read, write } = await wesh.kernel.pipe();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: 'cat',
      stdin: read,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;
    await write.close();

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
  });

  it('interrupts commands blocked on reads from process-opened file handles', async () => {
    const { read, write } = await wesh.kernel.pipe();
    wesh.vfs.registerSpecialFile({
      path: '/dev/hold',
      handler: () => read,
    });

    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: 'cat /dev/hold',
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;

    wesh.vfs.unregisterSpecialFile({ path: '/dev/hold' });
    await write.close();

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
  });

  it('does not rewrite wait status when signaling an already terminated process', async () => {
    const spawned = await wesh.kernel.spawn({
      image: 'test-proc',
      args: [],
    });

    await wesh.kernel.kill({
      pid: spawned.pid,
      signal: 2,
    });
    await wesh.kernel.kill({
      pid: spawned.pid,
      signal: 15,
    });

    expect(wesh.kernel.getWaitStatus({ pid: spawned.pid })).toEqual({
      kind: 'signaled',
      signal: 2,
    });
  });
});
