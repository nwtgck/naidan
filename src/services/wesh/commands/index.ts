import type { WeshCommandDefinition } from '@/services/wesh/types';
import { lsCommandDefinition } from './ls/index.ts';
import { cdCommandDefinition } from './cd/index.ts';
import { catCommandDefinition } from './cat/index.ts';
import { mkdirCommandDefinition } from './mkdir/index.ts';
import { rmCommandDefinition } from './rm/index.ts';
import { rmdirCommandDefinition } from './rmdir/index.ts';
import { echoCommandDefinition } from './echo/index.ts';
import { pwdCommandDefinition } from './pwd/index.ts';
import { whoamiCommandDefinition } from './whoami/index.ts';
import { grepCommandDefinition } from './grep/index.ts';
import { findCommandDefinition } from './find/index.ts';
import { headCommandDefinition } from './head/index.ts';
import { tailCommandDefinition } from './tail/index.ts';
import { touchCommandDefinition } from './touch/index.ts';
import { cpCommandDefinition } from './cp/index.ts';
import { mvCommandDefinition } from './mv/index.ts';
import { wcCommandDefinition } from './wc/index.ts';
import { sortCommandDefinition } from './sort/index.ts';
import { uniqCommandDefinition } from './uniq/index.ts';
import { cutCommandDefinition } from './cut/index.ts';
import { trCommandDefinition } from './tr/index.ts';
import { envCommandDefinition } from './env/index.ts';
import { exportCmdCommandDefinition } from './export/index.ts';
import { unsetCommandDefinition } from './unset/index.ts';
import { whichCommandDefinition } from './which/index.ts';
import { commandCommandDefinition } from './command/index.ts';
import { dateCommandDefinition } from './date/index.ts';
import { sleepCommandDefinition } from './sleep/index.ts';
import { historyCommandDefinition } from './history/index.ts';
import { clearCommandDefinition } from './clear/index.ts';
import { gzipCommandDefinition } from './gzip/index.ts';
import { gunzipCommandDefinition } from './gunzip/index.ts';
import { zcatCommandDefinition } from './zcat/index.ts';
import { mkfifoCommandDefinition } from './mkfifo/index.ts';
import { sedCommandDefinition } from './sed/index.ts';
import { evalCommandDefinition } from './eval/index.ts';
import { execCommandDefinition } from './exec/index.ts';
import { readCommandDefinition } from './read/index.ts';
import { lnCommandDefinition } from './ln/index.ts';
import { readlinkCommandDefinition } from './readlink/index.ts';
import { leftBracketCommandDefinition, testCommandDefinition } from './test/index.ts';
import { awkCommandDefinition } from './awk/index.ts';
import { jqCommandDefinition } from './jq/index.ts';
import { trapCommandDefinition } from './trap/index.ts';
import { xargsCommandDefinition } from './xargs/index.ts';

export const builtinCommands: WeshCommandDefinition[] = [
  lsCommandDefinition,
  cdCommandDefinition,
  catCommandDefinition,
  mkdirCommandDefinition,
  rmCommandDefinition,
  rmdirCommandDefinition,
  echoCommandDefinition,
  pwdCommandDefinition,
  whoamiCommandDefinition,
  grepCommandDefinition,
  findCommandDefinition,
  headCommandDefinition,
  tailCommandDefinition,
  touchCommandDefinition,
  cpCommandDefinition,
  mvCommandDefinition,
  wcCommandDefinition,
  sortCommandDefinition,
  uniqCommandDefinition,
  cutCommandDefinition,
  trCommandDefinition,
  envCommandDefinition,
  exportCmdCommandDefinition,
  unsetCommandDefinition,
  whichCommandDefinition,
  commandCommandDefinition,
  dateCommandDefinition,
  sleepCommandDefinition,
  historyCommandDefinition,
  clearCommandDefinition,
  gzipCommandDefinition,
  gunzipCommandDefinition,
  zcatCommandDefinition,
  mkfifoCommandDefinition,
  sedCommandDefinition,
  evalCommandDefinition,
  execCommandDefinition,
  readCommandDefinition,
  lnCommandDefinition,
  readlinkCommandDefinition,
  awkCommandDefinition,
  xargsCommandDefinition,
  jqCommandDefinition,
  trapCommandDefinition,
  testCommandDefinition,
  leftBracketCommandDefinition,
];
