import { describe, expect, it } from 'vitest';
import { splitEnvShebangArguments } from './shebang';

describe('shell shebang parsing', () => {
  it('splits env -S arguments using shell-relevant separators and grouping quotes', () => {
    const nonBreakingSpace = '\u00a0';

    expect(splitEnvShebangArguments({ optionalArgument: '-S "bash" -c' })).toEqual(['bash', '-c']);
    expect(splitEnvShebangArguments({ optionalArgument: "-S 'bash' -c" })).toEqual(['bash', '-c']);
    expect(splitEnvShebangArguments({ optionalArgument: '-S "" bash' })).toEqual(['', 'bash']);
    expect(splitEnvShebangArguments({ optionalArgument: '-S bash\\_--noprofile' })).toEqual(['bash', '--noprofile']);
    expect(splitEnvShebangArguments({ optionalArgument: '-S bash # ignored by env split-string' })).toEqual(['bash']);
    expect(splitEnvShebangArguments({ optionalArgument: '-S bash\\c ignored' })).toEqual(['bash']);
    expect(splitEnvShebangArguments({ optionalArgument: `-S bash${nonBreakingSpace}-e` })).toEqual([
      `bash${nonBreakingSpace}-e`,
    ]);
  });

  it('rejects unterminated env -S grouping quotes', () => {
    expect(splitEnvShebangArguments({ optionalArgument: '-S "bash' })).toBeUndefined();
    expect(splitEnvShebangArguments({ optionalArgument: "-S 'bash" })).toBeUndefined();
  });
});
