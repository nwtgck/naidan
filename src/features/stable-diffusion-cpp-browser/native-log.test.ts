import { expect, it } from 'vitest';
import { parseImageNativeLog } from './native-log';

it.each(['', '\n', '\r\n'])('recognizes the old prefix and current suffix with line ending %j', ending => {
  expect(parseImageNativeLog({ message: 'util.h:111  - graph-stage-v1 runner=qwen3vl stage=workspace-allocate event=begin' + ending })).toEqual({ sourceFile: 'util.h', message: 'graph-stage-v1 runner=qwen3vl stage=workspace-allocate event=begin' });
  expect(parseImageNativeLog({ message: 'graph-stage-v1 runner=qwen3vl stage=workspace-allocate event=begin --- util.h:111' + ending })).toEqual({ sourceFile: 'util.h', message: 'graph-stage-v1 runner=qwen3vl stage=workspace-allocate event=begin' });
});

it.each([
  'unstructured native output',
  'message -- util.h:111',
  'message --- util.h',
  'message --- /private/util.h:111',
  '/private/util.h:111 - message',
  'message --- util.h:111 extra',
  `\
message --- util.h:111
extra`,
  `\
util.h:111 - message
extra`,
  'message --- util.h:111\n\n',
  'util.h:111 - message\n\n',
  `\
first
second --- util.h:111`,
  'util.h:111 - ' + 'x'.repeat(2048),
])('rejects unrecognized, multiline and oversized formats: %j', message => {
  expect(parseImageNativeLog({ message })).toBeUndefined();
});
