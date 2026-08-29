import { describe, expect, it } from 'vitest';
import { parseShellShebangLine, splitEnvShebangArguments } from './shebang';

describe('shell shebang parsing', () => {
  it('matches Linux trailing space and tab handling on the shebang line', () => {
    expect(parseShellShebangLine({ firstLine: '#!/bin/bash -e   ' })).toEqual({
      interpreter: '/bin/bash',
      optionalArgument: '-e',
    });
    expect(parseShellShebangLine({ firstLine: '#!/bin/bash\t-e\t\t' })).toEqual({
      interpreter: '/bin/bash',
      optionalArgument: '-e',
    });
    expect(parseShellShebangLine({ firstLine: '#!/bin/bash   ' })).toEqual({
      interpreter: '/bin/bash',
      optionalArgument: undefined,
    });
    expect(parseShellShebangLine({ firstLine: '#!/bin/bash arg   \r' })).toEqual({
      interpreter: '/bin/bash',
      optionalArgument: 'arg   \r',
    });
  });

  it('matches Linux NUL termination of the shebang buffer', () => {
    expect(parseShellShebangLine({ firstLine: '#!/bin/bash -e\0ignored' })).toEqual({
      interpreter: '/bin/bash',
      optionalArgument: '-e',
    });
    expect(parseShellShebangLine({ firstLine: '#!/bin/bash\0ignored' })).toEqual({
      interpreter: '/bin/bash',
      optionalArgument: undefined,
    });
    expect(parseShellShebangLine({ firstLine: '#!/bin/bash   \0ignored' })).toEqual({
      interpreter: '/bin/bash',
      optionalArgument: '',
    });
    expect(parseShellShebangLine({ firstLine: '#!/bin/bash arg  \0ignored' })).toEqual({
      interpreter: '/bin/bash',
      optionalArgument: 'arg  ',
    });
  });

  it('splits env -S arguments using shell-relevant separators and grouping quotes', () => {
    const nonBreakingSpace = '\u00a0';

    expect(splitEnvShebangArguments({ optionalArgument: '-S "bash" -c' })).toEqual(['bash', '-c']);
    expect(splitEnvShebangArguments({ optionalArgument: '-Sbash -c' })).toEqual(['bash', '-c']);
    expect(splitEnvShebangArguments({ optionalArgument: '--split-string=bash -c' })).toEqual(['bash', '-c']);
    expect(splitEnvShebangArguments({ optionalArgument: '-S' })).toBeUndefined();
    expect(splitEnvShebangArguments({ optionalArgument: "-S 'bash' -c" })).toEqual(['bash', '-c']);
    expect(splitEnvShebangArguments({ optionalArgument: "-S 'bash\\'compat' -c" })).toEqual([
      "bash'compat",
      '-c',
    ]);
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S 'bash\\compat' -c` })).toEqual([
      String.raw`bash\compat`,
      '-c',
    ]);
    expect(splitEnvShebangArguments({ optionalArgument: '-S "" bash' })).toEqual(['', 'bash']);
    expect(splitEnvShebangArguments({ optionalArgument: '-S bash\\_--noprofile' })).toEqual(['bash', '--noprofile']);
    expect(splitEnvShebangArguments({ optionalArgument: '-S bash # ignored by env split-string' })).toEqual(['bash']);
    expect(splitEnvShebangArguments({ optionalArgument: '-S bash\\c ignored' })).toEqual(['bash']);
    expect(splitEnvShebangArguments({ optionalArgument: `-S bash${nonBreakingSpace}-e` })).toEqual([
      `bash${nonBreakingSpace}-e`,
    ]);
  });

  it('decodes GNU env -S escapes outside and inside double quotes', () => {
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S bash\n-e` })).toEqual([
      `\
bash
-e`,
    ]);
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S bash\t-e` })).toEqual([
      'bash\t-e',
    ]);
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S bash\\-e` })).toEqual([
      String.raw`bash\-e`,
    ]);
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S bash\#literal` })).toEqual([
      'bash#literal',
    ]);
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S bash\$HOME` })).toEqual([
      'bash$HOME',
    ]);
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S "bash\_--noprofile"` })).toEqual([
      'bash --noprofile',
    ]);
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S 'bash\n-e'` })).toEqual([
      String.raw`bash\n-e`,
    ]);
  });

  it('rejects GNU env -S invalid escape forms', () => {
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S bash\q` })).toBeUndefined();
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S bash\ ` })).toBeUndefined();
    expect(splitEnvShebangArguments({ optionalArgument: String.raw`-S "bash\c ignored"` })).toBeUndefined();
    expect(splitEnvShebangArguments({ optionalArgument: '-S bash\\' })).toBeUndefined();
  });

  it('rejects unterminated env -S grouping quotes', () => {
    expect(splitEnvShebangArguments({ optionalArgument: '-S "bash' })).toBeUndefined();
    expect(splitEnvShebangArguments({ optionalArgument: "-S 'bash" })).toBeUndefined();
  });
});
