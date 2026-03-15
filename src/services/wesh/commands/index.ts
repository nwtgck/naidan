import type { CommandDefinition } from '@/services/wesh/types';
import { lsCommandDefinition } from './ls';
import { cdCommandDefinition } from './cd';
import { catCommandDefinition } from './cat';
import { mkdirCommandDefinition } from './mkdir';
import { rmCommandDefinition } from './rm';
import { rmdirCommandDefinition } from './rmdir';
import { echoCommandDefinition } from './echo';
import { pwdCommandDefinition } from './pwd';
import { whoamiCommandDefinition } from './whoami';
import { grepCommandDefinition } from './grep';
import { findCommandDefinition } from './find';
import { headCommandDefinition } from './head';
import { tailCommandDefinition } from './tail';
import { touchCommandDefinition } from './touch';
import { cpCommandDefinition } from './cp';
import { mvCommandDefinition } from './mv';
import { wcCommandDefinition } from './wc';
import { sortCommandDefinition } from './sort';
import { uniqCommandDefinition } from './uniq';
import { cutCommandDefinition } from './cut';
import { trCommandDefinition } from './tr';
import { envCommandDefinition } from './env';
import { exportCmdCommandDefinition } from './export';
import { unsetCommandDefinition } from './unset';
import { whichCommandDefinition } from './which';
import { commandCommandDefinition } from './command';
import { dateCommandDefinition } from './date';
import { sleepCommandDefinition } from './sleep';
import { historyCommandDefinition } from './history';
import { clearCommandDefinition } from './clear';
import { gzipCommandDefinition } from './gzip';
import { gunzipCommandDefinition } from './gunzip';
import { zcatCommandDefinition } from './zcat';

export const builtinCommands: CommandDefinition[] = [
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
];
