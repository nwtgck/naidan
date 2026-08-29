import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { expandGitShortOptions } from '@/features/wesh/commands/git/short-options';

export type BranchDeleteMode = 'none' | 'safe' | 'force';
export type BranchListMode = 'local' | 'remote' | 'all';

export interface BranchArguments {
  showCurrent: boolean;
  move: boolean;
  deleteMode: BranchDeleteMode;
  listMode: BranchListMode;
  listOnly: boolean;
  operands: string[];
}

export function parseBranchArguments({ args }: { args: readonly string[] }): BranchArguments {
  let showCurrent = false;
  let move = false;
  let deleteMode: BranchDeleteMode = 'none';
  let listMode: BranchListMode = 'local';
  let listOnly = false;
  const operands: string[] = [];
  let parsingOptions = true;
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['m', 'd', 'D', 'r', 'a'], valueOptions: [] });
  for (const arg of normalizedArgs) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg === '--show-current')
      showCurrent = true;
    else if (parsingOptions && (arg === '-m' || arg === '--move'))
      move = true;
    else if (parsingOptions && (arg === '-d' || arg === '--delete')) {
      switch (deleteMode) {
      case 'none':
      case 'safe':
        deleteMode = 'safe';
        break;
      case 'force':
        break;
      default: {
        const _ex: never = deleteMode;
        throw new Error(`Unhandled branch delete mode: ${_ex}`);
      }
      }
    } else if (parsingOptions && arg === '-D')
      deleteMode = 'force';
    else if (parsingOptions && (arg === '-r' || arg === '--remotes'))
      listMode = 'remote';
    else if (parsingOptions && (arg === '-a' || arg === '--all'))
      listMode = 'all';
    else if (parsingOptions && arg === '--list')
      listOnly = true;
    else if (parsingOptions && arg === '--no-color')
      continue;
    else if (parsingOptions && arg.startsWith('-'))
      throw new GitUsageError({ message: `unknown option: ${arg}` });
    else
      operands.push(arg);
  }
  return { showCurrent, move, deleteMode, listMode, listOnly, operands };
}

export const TEST_ONLY = {
};
