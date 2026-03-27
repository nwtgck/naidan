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
import { printfCommandDefinition } from './printf/index.ts';
import { dirnameCommandDefinition } from './dirname/index.ts';
import { basenameCommandDefinition } from './basename/index.ts';
import { seqCommandDefinition } from './seq/index.ts';
import { teeCommandDefinition } from './tee/index.ts';
import { touchCommandDefinition } from './touch/index.ts';
import { cpCommandDefinition } from './cp/index.ts';
import { mvCommandDefinition } from './mv/index.ts';
import { wcCommandDefinition } from './wc/index.ts';
import { sortCommandDefinition } from './sort/index.ts';
import { uniqCommandDefinition } from './uniq/index.ts';
import { cutCommandDefinition } from './cut/index.ts';
import { trCommandDefinition } from './tr/index.ts';
import { shufCommandDefinition } from './shuf/index.ts';
import { commCommandDefinition } from './comm/index.ts';
import { pasteCommandDefinition } from './paste/index.ts';
import { realpathCommandDefinition } from './realpath/index.ts';
import { trueCommandDefinition } from './true/index.ts';
import { falseCommandDefinition } from './false/index.ts';
import { colonCommandDefinition } from './colon/index.ts';
import { envCommandDefinition } from './env/index.ts';
import { exportCmdCommandDefinition } from './export/index.ts';
import { unsetCommandDefinition } from './unset/index.ts';
import { whichCommandDefinition } from './which/index.ts';
import { commandCommandDefinition } from './command/index.ts';
import { dateCommandDefinition } from './date/index.ts';
import { sleepCommandDefinition } from './sleep/index.ts';
import { shoptCommandDefinition } from './shopt/index.ts';
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
import { fileCommandDefinition } from './file/index.ts';
import { trapCommandDefinition } from './trap/index.ts';
import { xargsCommandDefinition } from './xargs/index.ts';
import { xmlCommandDefinition } from './xml/index.ts';
import { zipCommandDefinition } from './zip/index.ts';
import { unzipCommandDefinition } from './unzip/index.ts';
import { timeCommandDefinition } from './time/index.ts';
import { xxdCommandDefinition } from './xxd/index.ts';
import { stringsCommandDefinition } from './strings/index.ts';
import { mktempCommandDefinition } from './mktemp/index.ts';
import { psCommandDefinition } from './ps/index.ts';

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
  printfCommandDefinition,
  dirnameCommandDefinition,
  basenameCommandDefinition,
  seqCommandDefinition,
  teeCommandDefinition,
  touchCommandDefinition,
  cpCommandDefinition,
  mvCommandDefinition,
  wcCommandDefinition,
  sortCommandDefinition,
  uniqCommandDefinition,
  cutCommandDefinition,
  trCommandDefinition,
  shufCommandDefinition,
  commCommandDefinition,
  pasteCommandDefinition,
  realpathCommandDefinition,
  trueCommandDefinition,
  falseCommandDefinition,
  colonCommandDefinition,
  envCommandDefinition,
  exportCmdCommandDefinition,
  unsetCommandDefinition,
  whichCommandDefinition,
  commandCommandDefinition,
  dateCommandDefinition,
  sleepCommandDefinition,
  shoptCommandDefinition,
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
  xmlCommandDefinition,
  zipCommandDefinition,
  unzipCommandDefinition,
  timeCommandDefinition,
  xargsCommandDefinition,
  jqCommandDefinition,
  fileCommandDefinition,
  trapCommandDefinition,
  xxdCommandDefinition,
  stringsCommandDefinition,
  mktempCommandDefinition,
  psCommandDefinition,
  testCommandDefinition,
  leftBracketCommandDefinition,
];
