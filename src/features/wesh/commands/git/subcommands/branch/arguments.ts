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
  for (const arg of args) {
    if (arg === '--show-current')
      showCurrent = true;
    else if (arg === '-m' || arg === '--move')
      move = true;
    else if (arg === '-d' || arg === '--delete')
      deleteMode = 'safe';
    else if (arg === '-D')
      deleteMode = 'force';
    else if (arg === '-r' || arg === '--remotes')
      listMode = 'remote';
    else if (arg === '-a' || arg === '--all')
      listMode = 'all';
    else if (arg === '--list')
      listOnly = true;
    else if (arg === '--no-color')
      continue;
    else if (arg.startsWith('-'))
      throw new Error(`unknown option: ${arg}`);
    else
      operands.push(arg);
  }
  return { showCurrent, move, deleteMode, listMode, listOnly, operands };
}

export const TEST_ONLY = {
};
