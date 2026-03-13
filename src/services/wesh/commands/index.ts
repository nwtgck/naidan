import type { CommandDefinition } from '../types';
import { ls } from './ls';
import { cd } from './cd';
import { cat } from './cat';
import { mkdir } from './mkdir';
import { rm } from './rm';
import { rmdir } from './rmdir';
import { echo } from './echo';
import { pwd } from './pwd';
import { whoami } from './whoami';
import { grep } from './grep';
import { find } from './find';
import { head } from './head';
import { tail } from './tail';
import { touch } from './touch';
import { cp } from './cp';
import { mv } from './mv';
import { wc } from './wc';
import { sort } from './sort';
import { uniq } from './uniq';
import { cut } from './cut';
import { tr } from './tr';
import { env } from './env';
import { exportCmd } from './export';
import { unset } from './unset';
import { which } from './which';
import { command } from './command';
import { date } from './date';
import { sleep } from './sleep';
import { history } from './history';
import { clear } from './clear';
import { gzip } from './gzip';
import { gunzip } from './gunzip';
import { zcat } from './zcat';

export const builtinCommands: CommandDefinition[] = [
  ls,
  cd,
  cat,
  mkdir,
  rm,
  rmdir,
  echo,
  pwd,
  whoami,
  grep,
  find,
  head,
  tail,
  touch,
  cp,
  mv,
  wc,
  sort,
  uniq,
  cut,
  tr,
  env,
  exportCmd,
  unset,
  which,
  command,
  date,
  sleep,
  history,
  clear,
  gzip,
  gunzip,
  zcat,
];
