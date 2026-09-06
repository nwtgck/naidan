import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import type { WeshProcessSnapshot } from '@/features/wesh/types';
import { TEST_ONLY } from './index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh ps', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'ps --help' });
    const invalid = await execute({ script: 'ps --bogus' });
    const extra = await execute({ script: 'ps extra' });
    const badFormat = await execute({ script: 'ps -o nope' });
    const badPid = await execute({ script: 'ps -p abc' });

    expect(help.stdout.text).toContain('Report process status');
    expect(help.stdout.text).toContain('usage: ps [-eA] [-p PIDLIST] [-q PIDLIST] [--forest] [-o FORMAT]');
    expect(help.stdout.text).toContain('-p');
    expect(help.stdout.text).toContain('-q');
    expect(help.stdout.text).toContain('-o');
    expect(help.stdout.text).toContain('-f');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("ps: unrecognized option '--bogus'");
    expect(invalid.result.exitCode).toBe(1);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain('ps: extra operand');
    expect(extra.result.exitCode).toBe(1);

    expect(badFormat.stdout.text).toBe('');
    expect(badFormat.stderr.text).toContain('ps: unknown user-defined format specifier: nope');
    expect(badFormat.result.exitCode).toBe(1);

    expect(badPid.stdout.text).toBe('');
    expect(badPid.stderr.text).toContain('ps: invalid process ID: abc');
    expect(badPid.result.exitCode).toBe(1);
  });

  it('validates PID selections before a later help request', async () => {
    for (const pidList of ['invalid', '0']) {
      const beforeHelp = await execute({ script: `ps -p '${pidList}' --help` });
      expect(beforeHelp.result.exitCode).toBe(1);
      expect(beforeHelp.stdout.text).toBe('');
      expect(beforeHelp.stderr.text).toContain('ps:');
    }

    const inline = await execute({ script: 'ps --pid=invalid --help' });
    expect(inline.result.exitCode).toBe(1);
    expect(inline.stdout.text).toBe('');
    expect(inline.stderr.text).toContain('ps: invalid process ID');

    const helpFirst = await execute({ script: 'ps --help -p invalid' });
    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).toContain('Report process status');
    expect(helpFirst.stderr.text).toBe('');

    const invalidFormatBeforeHelp = await execute({ script: 'ps -o bogus --help' });
    expect(invalidFormatBeforeHelp.result.exitCode).toBe(0);
    expect(invalidFormatBeforeHelp.stdout.text).toContain('Report process status');
    expect(invalidFormatBeforeHelp.stderr.text).toBe('');
  });

  it('formats process counts above the JavaScript function argument limit', () => {
    const processCount = 150_000;
    const processes: WeshProcessSnapshot[] = Array.from({ length: processCount }, (_value, index) => ({
      pid: index + 2,
      ppid: 1,
      pgid: 2,
      state: 'running',
      user: 'user',
      argv0: 'worker',
      args: ['worker'],
      cwd: '/',
    }));

    const output = TEST_ONLY.formatProcesses({
      columns: TEST_ONLY.defaultColumns(),
      processes,
    });
    let newlineCount = 0;
    for (const character of output) {
      if (character === '\n') newlineCount += 1;
    }

    expect(newlineCount).toBe(processCount + 1);
    expect(output).toContain('PID');
    expect(output).toContain('COMMAND');
    expect(output).toContain('150001');
  });

  it('renders each process on one line without terminal control characters', () => {
    const parsedColumns = TEST_ONLY.parseFormatList({ raw: 'args,pid' });
    if (parsedColumns.kind !== 'ok') throw new Error(parsedColumns.message);
    const processNames = [
      'a\tb',
      `\
a
b`,
      'a\rb',
      'a\u001bb',
    ];
    const processes: WeshProcessSnapshot[] = processNames.map((argv0, index) => ({
      pid: index + 2,
      ppid: 1,
      pgid: 2,
      state: 'running',
      user: 'user',
      argv0,
      args: [],
      cwd: '/',
    }));

    expect(TEST_ONLY.formatProcesses({
      columns: parsedColumns.columns,
      processes,
    })).toBe(`\
COMMAND     PID
a?b           2
a b           3
a?b           4
a?b           5
`);
    const customHeaderColumns = TEST_ONLY.parseFormatList({ raw: 'args=COMMAND,pid=\u001b[31m' });
    if (customHeaderColumns.kind !== 'ok') throw new Error(customHeaderColumns.message);
    expect(TEST_ONLY.formatProcesses({
      columns: customHeaderColumns.columns,
      processes: processes.slice(0, 1),
    })).toBe(`\
COMMAND   ?[31m
a?b           2
`);
  });

  it('aligns process fields by terminal display width', () => {
    const parsedColumns = TEST_ONLY.parseFormatList({ raw: 'args,pid' });
    if (parsedColumns.kind !== 'ok') throw new Error(parsedColumns.message);
    const processes: WeshProcessSnapshot[] = ['a', '表', 'e\u0301', '😀'].map((argv0, index) => ({
      pid: index + 2,
      ppid: 1,
      pgid: 2,
      state: 'running',
      user: 'user',
      argv0,
      args: [],
      cwd: '/',
    }));

    expect(TEST_ONLY.formatProcesses({
      columns: parsedColumns.columns,
      processes,
    })).toBe(`\
COMMAND     PID
a             2
表            3
e\u0301             4
😀            5
`);
  });

  it('shows the current process group by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'ps',
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('PID');
    expect(stdout.text).toContain('PGID');
    expect(stdout.text).toContain('COMMAND');
    expect(stdout.text).toContain('wesh');
    expect(stdout.text).toContain('ps');
  });

  it('supports -e and custom output formats', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'ps -e -o pid,ppid,pgid,stat,args',
    });

    const lines = stdout.text.trimEnd().split('\n');
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(lines[0]).toBe('    PID    PPID    PGID STAT COMMAND');
    expect(lines.some(line => line.includes('wesh -l'))).toBe(true);
    expect(lines.some(line => line.includes('ps -e -o pid,ppid,pgid,stat,args'))).toBe(true);
  });

  it('supports bounded --sort keys over existing process metadata', async () => {
    const descendingPid = await execute({ script: 'ps -e --sort=-pid -o pid=' });
    const compound = await execute({ script: 'ps -e --sort=ppid,pid -o ppid=,pid=' });
    const metadata = await execute({ script: 'ps -e --sort=stat,user,cwd,pid -o pid=' });

    expect(descendingPid.result.exitCode).toBe(0);
    expect(descendingPid.stderr.text).toBe('');
    const descendingPids = descendingPid.stdout.text.trim().split(/\s+/u).map(Number);
    expect(descendingPids.length).toBeGreaterThan(1);
    expect(descendingPids).toEqual(descendingPids.slice().sort((left, right) => right - left));

    expect(compound.result.exitCode).toBe(0);
    expect(compound.stderr.text).toBe('');
    const pairs = compound.stdout.text.trim().split('\n').map((line) => line.trim().split(/\s+/u).map(Number));
    for (let index = 1; index < pairs.length; index += 1) {
      const previous = pairs[index - 1]!;
      const current = pairs[index]!;
      expect(
        current[0]! > previous[0]!
        || (current[0] === previous[0] && current[1]! >= previous[1]!),
      ).toBe(true);
    }

    expect(metadata.result.exitCode).toBe(0);
    expect(metadata.stderr.text).toBe('');
  });

  it('renders --forest from existing PID/PPID topology', async () => {
    const result = await execute({
      script: 'ps -e --forest -o pid=,ppid=,args=',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toMatch(/\\_ .*ps -e --forest -o pid=,ppid=,args=/u);
  });

  it('keeps forest topology finite and stable for missing parents, multiple roots, and cycles', () => {
    const process = ({
      pid,
      ppid,
      argv0,
    }: {
      pid: number,
      ppid: number,
      argv0: string,
    }): WeshProcessSnapshot => ({
      pid,
      ppid,
      pgid: 1,
      state: 'running',
      user: 'user',
      argv0,
      args: [],
      cwd: '/',
    });
    const processes = [
      process({ pid: 30, ppid: 31, argv0: 'cycle-a' }),
      process({ pid: 10, ppid: 99, argv0: 'orphan' }),
      process({ pid: 1, ppid: 0, argv0: 'root' }),
      process({ pid: 3, ppid: 1, argv0: 'child-b' }),
      process({ pid: 2, ppid: 1, argv0: 'child-a' }),
      process({ pid: 4, ppid: 2, argv0: 'grandchild' }),
      process({ pid: 31, ppid: 30, argv0: 'cycle-b' }),
    ];

    const layout = TEST_ONLY.layoutProcessesAsForest({ processes });

    expect(layout.processes.map(({ pid }) => pid)).toEqual([10, 1, 3, 2, 4, 30, 31]);
    expect([...layout.depthByPid.entries()]).toEqual([
      [10, 0],
      [1, 0],
      [3, 1],
      [2, 1],
      [4, 2],
      [30, 0],
      [31, 1],
    ]);

    const parsedColumns = TEST_ONLY.parseFormatList({ raw: 'args=' });
    if (parsedColumns.kind !== 'ok') throw new Error(parsedColumns.message);
    const columns = TEST_ONLY.decorateForestColumns({
      columns: parsedColumns.columns,
      depthByPid: layout.depthByPid,
    });
    expect(TEST_ONLY.formatProcesses({
      columns,
      processes: layout.processes,
      includeHeader: false,
    })).toBe(`\
orphan
root
 \\_ child-b
 \\_ child-a
     \\_ grandchild
cycle-a
 \\_ cycle-b
`);
  });

  it('rejects ps sort keys whose metadata is not authoritative in the command layer', async () => {
    const unsupported = await execute({ script: 'ps -e --sort=comm -o pid=' });

    expect(unsupported.result.exitCode).toBe(1);
    expect(unsupported.stdout.text).toBe('');
    expect(unsupported.stderr.text).toContain('ps: unsupported sort key: comm');
  });

  it('supports the common -ef fuller listing form', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'ps -ef',
    });

    const lines = stdout.text.trimEnd().split('\n');
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(lines[0]).toContain('USER');
    expect(lines[0]).toContain('PID');
    expect(lines[0]).toContain('COMMAND');
    expect(lines.some(line => line.includes('wesh -l'))).toBe(true);
    expect(lines.some(line => line.includes('ps -ef'))).toBe(true);
  });

  it('supports selecting specific process IDs with -p', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;

    const { result, stdout, stderr } = await execute({
      script: `ps -p ${shellPid} -o pid,args`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('    PID COMMAND');
    expect(stdout.text).toContain(`${shellPid}`);
    expect(stdout.text).toContain('wesh');
  });

  it('supports quick PID selection while preserving requested order and duplicates', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;

    const quick = await execute({
      script: `ps -q ${shellPid},1,${shellPid} -o pid=`,
    });
    const long = await execute({
      script: `ps --quick-pid=${shellPid} --no-headers -o pid`,
    });

    expect(quick.result.exitCode).toBe(0);
    expect(quick.stderr.text).toBe('');
    expect(quick.stdout.text.trimEnd().split('\n').map(line => Number(line.trim()))).toEqual([
      shellPid,
      1,
      shellPid,
    ]);
    expect(long.result.exitCode).toBe(0);
    expect(long.stderr.text).toBe('');
    expect(long.stdout.text.trim()).toBe(`${shellPid}`);
  });

  it('rejects quick PID selection combined with other selection or sort options', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;
    const selectionCases = [
      `ps -q ${shellPid} -p 1 -o pid=`,
      `ps -q ${shellPid} --ppid 1 -o pid=`,
      `ps -q ${shellPid} -e -o pid=`,
    ];

    for (const script of selectionCases) {
      const rejected = await execute({ script });
      expect(rejected.result.exitCode).toBe(1);
      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toContain('cannot be combined with other selection options');
    }

    const sorted = await execute({
      script: `ps -q ${shellPid} --sort=-pid -o pid=`,
    });
    expect(sorted.result.exitCode).toBe(1);
    expect(sorted.stdout.text).toBe('');
    expect(sorted.stderr.text).toContain('cannot be used together with sort options');

    const forest = await execute({
      script: `ps -q ${shellPid} --forest -o pid=`,
    });
    expect(forest.result.exitCode).toBe(1);
    expect(forest.stdout.text).toBe('');
    expect(forest.stderr.text).toContain('cannot be used together with forest type listings');
  });

  it('returns 1 when quick PID selection finds no process', async () => {
    const missing = await execute({
      script: 'ps -q 99999999 -o pid=',
    });

    expect(missing.result.exitCode).toBe(1);
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toBe('');
  });

  it('supports header suppression and custom headers in -o formats', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;

    const suppressed = await execute({
      script: `ps -p ${shellPid} -o pid=`,
    });
    const custom = await execute({
      script: `ps -p ${shellPid} -o pid=PIDX,args=CMDX`,
    });

    expect(suppressed.stderr.text).toBe('');
    expect(suppressed.stdout.text.trim()).toBe(`${shellPid}`);
    expect(suppressed.result.exitCode).toBe(0);
    expect(custom.stderr.text).toBe('');
    expect(custom.stdout.text.split('\n')[0]).toBe('   PIDX CMDX');
    expect(custom.result.exitCode).toBe(0);
  });

  it('appends repeated -o formats and supports comm', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;

    const { result, stdout, stderr } = await execute({
      script: `ps -p ${shellPid} -o pid=PID -o ppid=PPID -o comm=`,
    });

    const lines = stdout.text.trimEnd().split('\n');
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(lines[0]).toBe('    PID    PPID');
    expect(lines[1]?.trim().split(/\s+/u)).toHaveLength(3);
    expect(lines[1]).toContain('wesh');
  });

  it('uses GNU ps whitespace rules for PID and format lists', async () => {
    for (const format of ['pid comm', 'pid\tcomm', 'pid,comm']) {
      const { result, stderr } = await execute({ script: `ps -p 1 -o '${format}'` });
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }

    for (const format of ['pid\u00A0comm', 'pid\u2003comm', 'pid\uFEFFcomm']) {
      const { result, stdout, stderr } = await execute({ script: `ps -p 1 -o '${format}'` });
      expect(stdout.text).toBe('');
      expect(stderr.text).toContain('ps: unknown user-defined format specifier');
      expect(result.exitCode).toBe(1);
    }

    for (const pidList of [' 1 ', '\t1\t', '\u00A01\u00A0', '\u20031\u2003', '\uFEFF1\uFEFF']) {
      const { result, stdout, stderr } = await execute({ script: `ps -p '${pidList}' -o pid` });
      expect(stdout.text).toBe('');
      expect(stderr.text).toContain('ps: invalid process ID');
      expect(result.exitCode).toBe(1);
    }
  });

  it('uses procps minimum widths for PID-family columns in -o formats', async () => {
    const combined = await execute({
      script: 'ps -p 999999 -o pid=PID,pgid=PGID,ppid=PPID,stat=STAT,args=COMMAND',
    });
    const shortHeader = await execute({
      script: 'ps -p 999999 -o pid=Z',
    });

    expect(combined.stdout.text).toBe('    PID    PGID    PPID STAT COMMAND\n');
    expect(combined.stderr.text).toBe('');
    expect(combined.result.exitCode).toBe(1);
    expect(shortHeader.stdout.text).toBe('      Z\n');
    expect(shortHeader.stderr.text).toBe('');
    expect(shortHeader.result.exitCode).toBe(1);
  });

  it('preserves non-ASCII trailing whitespace in custom headers', async () => {
    const cases = [
      ['X ', 'X\n'],
      ['X\t', 'X\n'],
      ['X\u00A0', 'X\u00A0\n'],
      ['X\u2003', 'X\u2003\n'],
      ['X\uFEFF', 'X\uFEFF\n'],
    ] as const;

    for (const [header, expected] of cases) {
      const { result, stdout, stderr } = await execute({
        script: `ps -p 999999 -o 'pid=${header}'`,
      });
      expect(stdout.text.replace(/^ +/u, '')).toBe(expected);
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(1);
    }
  });

  it('rejects empty members in PID lists', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;

    for (const pidList of [`${shellPid},`, `,${shellPid}`, '']) {
      const { result, stdout, stderr } = await execute({
        script: `ps -p '${pidList}' -o pid=`,
      });

      expect(result.exitCode).toBe(1);
      expect(stdout.text).toBe('');
      expect(stderr.text).toContain('ps: process ID list cannot be empty');
    }
  });

  it('returns 1 when an explicit PID selection is empty', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'ps -p 99999999 -o pid=',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('supports --ppid selection over authoritative process metadata', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;
    const { result, stdout, stderr } = await execute({
      script: `ps --ppid ${shellPid} -o ppid=,args=`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`${shellPid}`);
    expect(stdout.text).toContain('ps --ppid');
  });

  it('supports --no-headers without changing selected rows', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;
    const { result, stdout, stderr } = await execute({
      script: `ps -p ${shellPid} --no-headers -o pid`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text.trim()).toBe(`${shellPid}`);
  });

  it('supports combining -f with -p for a fuller targeted listing', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;

    const { result, stdout, stderr } = await execute({
      script: `ps -fp ${shellPid}`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('USER   PID  PPID  PGID STAT COMMAND');
    expect(stdout.text).toContain(`${shellPid}`);
    expect(stdout.text).toContain('wesh');
  });

  it('uses the configured process user independently of the USER environment variable', async () => {
    const { result, stdout } = await execute({
      script: `\
unset USER
sleep 0.2 &
ps -ef`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain('USER');
    expect(stdout.text).toContain('user');
    expect(stdout.text).toContain('sleep 0.2');
  });

  it('can show background processes with -e', async () => {
    const { result, stdout } = await execute({
      script: `\
sleep 0.2 &
ps -e -o pid,stat,args`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain('  PID STAT COMMAND');
    expect(stdout.text).toContain('sleep 0.2');
    expect(stdout.text).toContain('R');
  });

  it('accepts explicit positive PID signs and rejects out-of-range IDs', async () => {
    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;
    const accepted = await execute({
      script: `ps -p +${shellPid} -o pid=`,
    });

    expect(accepted.stdout.text.trim()).toBe(`${shellPid}`);
    expect(accepted.stderr.text).toBe('');
    expect(accepted.result.exitCode).toBe(0);

    for (const pidList of ['+0', '+999999999999999999999']) {
      const rejected = await execute({ script: `ps -p '${pidList}' -o pid=` });
      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toContain('ps: process ID out of range');
      expect(rejected.result.exitCode).toBe(1);
    }
  });

});
