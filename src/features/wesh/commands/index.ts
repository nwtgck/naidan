import type { WeshCommandDefinition } from '@/features/wesh/types';
import { lsCommandDefinition } from './ls/definition.ts';
import { cdCommandDefinition } from './cd/definition.ts';
import { catCommandDefinition } from './cat/definition.ts';
import { cmpCommandDefinition } from './cmp/definition.ts';
import { mkdirCommandDefinition } from './mkdir/definition.ts';
import { rmCommandDefinition } from './rm/definition.ts';
import { rmdirCommandDefinition } from './rmdir/definition.ts';
import { echoCommandDefinition } from './echo/definition.ts';
import { pwdCommandDefinition } from './pwd/definition.ts';
import { whoamiCommandDefinition } from './whoami/definition.ts';
import { grepCommandDefinition } from './grep/definition.ts';
import { findCommandDefinition } from './find/definition.ts';
import { headCommandDefinition } from './head/definition.ts';
import { tailCommandDefinition } from './tail/definition.ts';
import { treeCommandDefinition } from './tree/definition.ts';
import { printfCommandDefinition } from './printf/definition.ts';
import { dirnameCommandDefinition } from './dirname/definition.ts';
import { basenameCommandDefinition } from './basename/definition.ts';
import { aliasCommandDefinition } from './alias/definition.ts';
import { seqCommandDefinition } from './seq/definition.ts';
import { teeCommandDefinition } from './tee/definition.ts';
import { touchCommandDefinition } from './touch/definition.ts';
import { cpCommandDefinition } from './cp/definition.ts';
import { mvCommandDefinition } from './mv/definition.ts';
import { wcCommandDefinition } from './wc/definition.ts';
import { sortCommandDefinition } from './sort/definition.ts';
import { uniqCommandDefinition } from './uniq/definition.ts';
import { cutCommandDefinition } from './cut/definition.ts';
import { trCommandDefinition } from './tr/definition.ts';
import { shufCommandDefinition } from './shuf/definition.ts';
import { commCommandDefinition } from './comm/definition.ts';
import { pasteCommandDefinition } from './paste/definition.ts';
import { columnCommandDefinition } from './column/definition.ts';
import { realpathCommandDefinition } from './realpath/definition.ts';
import { trueCommandDefinition } from './true/definition.ts';
import { falseCommandDefinition } from './false/definition.ts';
import { colonCommandDefinition } from './colon/definition.ts';
import { envCommandDefinition } from './env/definition.ts';
import { exportCmdCommandDefinition } from './export/definition.ts';
import { unsetCommandDefinition } from './unset/definition.ts';
import { setCommandDefinition } from './set/definition.ts';
import { unaliasCommandDefinition } from './unalias/definition.ts';
import { whichCommandDefinition } from './which/definition.ts';
import { commandCommandDefinition } from './command/definition.ts';
import { dateCommandDefinition } from './date/definition.ts';
import { sleepCommandDefinition } from './sleep/definition.ts';
import { killCommandDefinition } from './kill/definition.ts';
import { typeCommandDefinition } from './type/definition.ts';
import { shoptCommandDefinition } from './shopt/definition.ts';
import { historyCommandDefinition } from './history/definition.ts';
import { clearCommandDefinition } from './clear/definition.ts';
import { gzipCommandDefinition } from './gzip/definition.ts';
import { gunzipCommandDefinition } from './gunzip/definition.ts';
import { zcatCommandDefinition } from './zcat/definition.ts';
import { mkfifoCommandDefinition } from './mkfifo/definition.ts';
import { sedCommandDefinition } from './sed/definition.ts';
import { evalCommandDefinition } from './eval/definition.ts';
import { execCommandDefinition } from './exec/definition.ts';
import { readCommandDefinition } from './read/definition.ts';
import { lnCommandDefinition } from './ln/definition.ts';
import { nlCommandDefinition } from './nl/definition.ts';
import { readlinkCommandDefinition } from './readlink/definition.ts';
import { statCommandDefinition } from './stat/definition.ts';
import { leftBracketCommandDefinition, testCommandDefinition } from './test/definition.ts';
import { awkCommandDefinition } from './awk/definition.ts';
import { jqCommandDefinition } from './jq/definition.ts';
import { fileCommandDefinition } from './file/definition.ts';
import { trapCommandDefinition } from './trap/definition.ts';
import { xargsCommandDefinition } from './xargs/definition.ts';
import { xmlCommandDefinition } from './xml/definition.ts';
import { zipCommandDefinition } from './zip/definition.ts';
import { unzipCommandDefinition } from './unzip/definition.ts';
import { timeCommandDefinition } from './time/definition.ts';
import { xxdCommandDefinition } from './xxd/definition.ts';
import { stringsCommandDefinition } from './strings/definition.ts';
import { mktempCommandDefinition } from './mktemp/definition.ts';
import { psCommandDefinition } from './ps/definition.ts';
import { foldCommandDefinition } from './fold/definition.ts';
import { base64CommandDefinition } from './base64/definition.ts';
import { diffCommandDefinition } from './diff/definition.ts';
import { sha256sumCommandDefinition } from './sha256sum/definition.ts';
import { patchCommandDefinition } from './patch/definition.ts';
import { duCommandDefinition } from './du/definition.ts';
import { splitCommandDefinition } from './split/definition.ts';
import { csplitCommandDefinition } from './csplit/definition.ts';
import { umaskCommandDefinition } from './umask/definition.ts';
import { gitCommandDefinition } from './git/definition.ts';

export const builtinCommands: WeshCommandDefinition[] = [
  lsCommandDefinition,
  cdCommandDefinition,
  catCommandDefinition,
  cmpCommandDefinition,
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
  treeCommandDefinition,
  printfCommandDefinition,
  dirnameCommandDefinition,
  basenameCommandDefinition,
  aliasCommandDefinition,
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
  columnCommandDefinition,
  realpathCommandDefinition,
  trueCommandDefinition,
  falseCommandDefinition,
  colonCommandDefinition,
  envCommandDefinition,
  exportCmdCommandDefinition,
  unsetCommandDefinition,
  setCommandDefinition,
  unaliasCommandDefinition,
  whichCommandDefinition,
  commandCommandDefinition,
  dateCommandDefinition,
  sleepCommandDefinition,
  killCommandDefinition,
  typeCommandDefinition,
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
  nlCommandDefinition,
  readlinkCommandDefinition,
  statCommandDefinition,
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
  foldCommandDefinition,
  base64CommandDefinition,
  diffCommandDefinition,
  sha256sumCommandDefinition,
  patchCommandDefinition,
  duCommandDefinition,
  splitCommandDefinition,
  csplitCommandDefinition,
  umaskCommandDefinition,
  gitCommandDefinition,
  testCommandDefinition,
  leftBracketCommandDefinition,
];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
