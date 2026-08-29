import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { applyCheckoutTreePlan, planCheckoutTree } from "./checkout";
import type { GitCheckoutConflict } from "./checkout";
import { commitSubject, createCommit, parseCommitAuthor, readCommit } from "./commits";
import { readEffectiveConfig } from "./config";
import { sortGitPaths } from "./path-order";
import { applyMergedIndexWithConflicts } from "./merge-apply";
import { formatPreparedMergeConflict, prepareMergeConflicts } from "./merge-conflict";
import type { GitPreparedMergeConflict } from "./merge-conflict";
import { readMergeState } from "./merge-state";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "./identity";
import { readIndex, writeIndex } from "./index-file";
import { forceReplaceIndexAndWorktree } from "./index-worktree";
import { branchNameFromHead, readHead, updateHead } from "./refs";
import { discoverRepository, discoverRepositoryFromContext } from "./repository";
import { resolveCommitRevision } from "./revision";
import { prepareCommitReplay } from "./replay";
import type { GitPreparedReplay } from "./replay";
import type { GitReplayKind } from "./replay-state";
import { clearReplayState, readReplayState, writeReplayState } from "./replay-state";
import { advanceSequencer, clearSequencerState, readSequencerState, writeSequencerState } from "./sequencer-state";
import { readTreeIntoIndex, writeTreeFromIndex } from "./tree";
import { firstLine } from "./commit-message";
import { resolveContentConfigForContext } from "./content-config";
import { printCheckoutConflicts } from "./checkout-like";

export async function createReplayCommit({ context, repository, kind, sourceObjectId, message, reflogPrefix }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    kind: GitReplayKind;
    sourceObjectId: string;
    message: string;
    reflogPrefix: string;
}): Promise<{
    objectId: string;
    subject: string;
}> {
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error(`cannot ${kind} on an unborn branch`);
  const entries = await readIndex({ files: context.files, repository });
  const treeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries });
  const sourceCommit = await readCommit({ files: context.files, repository, objectId: sourceObjectId });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  let authorOverride;
  switch (kind) {
  case 'cherry-pick':
    authorOverride = parseCommitAuthor({ value: sourceCommit.author });
    break;
  case 'revert':
    authorOverride = undefined;
    break;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled replay kind: ${_ex}`);
  }
  }
  const created = await createCommit({
    files: context.files,
    repository,
    config,
    env: context.env,
    treeObjectId,
    parentObjectIds: [head.objectId],
    message,
    authorOverride,
  });
  const subject = firstLine({ text: message });
  await updateHead({
    files: context.files,
    repository,
    objectId: created.objectId,
    reflog: {
      identity: created.committerIdentity,
      timestamp: created.committerTimestamp,
      message: `${reflogPrefix}: ${subject}`,
    },
  });
  return { objectId: created.objectId, subject };
}
export type GitReplayStepResult = {
    type: 'committed';
    objectId: string;
    subject: string;
    autoMergedPaths: string[];
} | {
    type: 'conflicted';
    replay: GitPreparedReplay;
    preparedConflicts: GitPreparedMergeConflict[];
} | {
    type: 'checkout-conflict';
    conflicts: GitCheckoutConflict[];
};
export async function applyReplayStep({ context, repository, kind, sourceObjectId, reflogPrefix, mainlineParentNumber }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    kind: GitReplayKind;
    sourceObjectId: string;
    reflogPrefix: string;
    mainlineParentNumber?: number;
}): Promise<GitReplayStepResult> {
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error(`cannot ${kind} on an unborn branch`);
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const replay = await prepareCommitReplay({
    files: context.files,
    repository,
    kind,
    sourceObjectId,
    currentHeadObjectId: head.objectId,
    mainlineParentNumber,
  });
  if (replay.conflicts.length > 0) {
    const preparedConflicts = await prepareMergeConflicts({
      files: context.files,
      repository,
      conflicts: replay.conflicts,
      oursLabel: 'HEAD',
      theirsLabel: replay.theirsLabel,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    const applied = await applyMergedIndexWithConflicts({
      files: context.files,
      repository,
      currentHeadEntries: replay.currentHeadEntries,
      currentIndexEntries,
      mergedEntries: replay.mergedEntries,
      preparedConflicts,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    if (applied.checkoutConflicts.length > 0) {
      return { type: 'checkout-conflict', conflicts: applied.checkoutConflicts };
    }
    return { type: 'conflicted', replay, preparedConflicts };
  }
  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries: replay.currentHeadEntries,
    currentIndexEntries,
    targetEntries: replay.mergedEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0)
    return { type: 'checkout-conflict', conflicts: plan.conflicts };
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const created = await createReplayCommit({
    context,
    repository,
    kind,
    sourceObjectId,
    message: replay.message,
    reflogPrefix,
  });
  return {
    type: 'committed',
    objectId: created.objectId,
    subject: created.subject,
    autoMergedPaths: replay.autoMergedPaths,
  };
}
async function printReplayCommit({ context, objectId, subject }: {
    context: WeshCommandContext;
    objectId: string;
    subject: string;
}): Promise<void> {
  const repository = await discoverRepositoryFromContext({ context });
  const updatedHead = await readHead({ files: context.files, repository });
  await context.text().print({
    text: `[${branchNameFromHead({ head: updatedHead }) ?? 'detached HEAD'} ${objectId.slice(0, 7)}] ${subject}\n`,
  });
}
async function applyReplayObject({ context, repository, kind, sourceObjectId, mainlineParentNumber }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    kind: GitReplayKind;
    sourceObjectId: string;
    mainlineParentNumber?: number;
}): Promise<WeshCommandResult> {
  let result: GitReplayStepResult;
  try {
    result = await applyReplayStep({
      context,
      repository,
      kind,
      sourceObjectId,
      reflogPrefix: kind,
      mainlineParentNumber,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^commit [0-9a-f]{40} (?:is a merge but no -m option was given\.|does not have parent [0-9]+)$/u.test(message)) {
      await context.text().error({ text: `error: ${message}\n` });
      await context.text().error({ text: `fatal: ${kind} failed\n` });
      return { exitCode: 128 };
    }
    await context.text().error({ text: `fatal: ${message}\n` });
    return { exitCode: 1 };
  }
  switch (result.type) {
  case 'checkout-conflict':
    await printCheckoutConflicts({ context, conflicts: result.conflicts });
    return { exitCode: 1 };
  case 'conflicted': {
    await writeReplayState({
      files: context.files,
      repository,
      kind,
      sourceObjectId,
      message: result.replay.message,
      conflictPaths: result.preparedConflicts.map(conflict => conflict.path),
    });
    for (const path of result.replay.autoMergedPaths)
      await context.text().print({ text: `Auto-merging ${path}\n` });
    for (const conflict of result.preparedConflicts) {
      for (const text of formatPreparedMergeConflict({ conflict, oursLabel: 'HEAD', theirsLabel: result.replay.theirsLabel })) {
        await context.text().print({ text });
      }
    }
    let action: 'apply' | 'revert';
    switch (kind) {
    case 'cherry-pick':
      action = 'apply';
      break;
    case 'revert':
      action = 'revert';
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled replay kind: ${_ex}`);
    }
    }
    await context.text().error({
      text: `error: could not ${action} ${sourceObjectId.slice(0, 7)}... ${commitSubject({ commit: result.replay.sourceCommit })}\n`,
    });
    return { exitCode: 1 };
  }
  case 'committed':
    for (const path of result.autoMergedPaths)
      await context.text().print({ text: `Auto-merging ${path}\n` });
    await printReplayCommit({ context, objectId: result.objectId, subject: result.subject });
    return { exitCode: 0 };
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled replay result: ${String(_ex)}`);
  }
  }
}
export async function executeSequencerSteps({ context, repository, kind }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    kind: GitReplayKind;
}): Promise<WeshCommandResult> {
  while (true) {
    const state = await readSequencerState({ files: context.files, repository });
    if (state === undefined)
      return { exitCode: 0 };
    const step = state.todo[0];
    if (step === undefined) {
      await clearSequencerState({ files: context.files, repository });
      return { exitCode: 0 };
    }
    if (step.kind !== kind)
      throw new Error(`sequencer kind mismatch: expected ${kind}, found ${step.kind}`);
    const result = await applyReplayObject({
      context,
      repository,
      kind,
      sourceObjectId: step.objectId,
      mainlineParentNumber: state.mainlineParentNumber,
    });
    if (result.exitCode !== 0)
      return result;
    await advanceSequencer({ files: context.files, repository });
  }
}
async function continueReplay({ context, kind }: {
    context: WeshCommandContext;
    kind: GitReplayKind;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const sequence = await readSequencerState({ files: context.files, repository });
  const state = await readReplayState({ files: context.files, repository });
  if (state === undefined) {
    if (sequence !== undefined && sequence.todo[0]?.kind === kind) {
      return executeSequencerSteps({ context, repository, kind });
    }
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  if (state.kind !== kind) {
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  if (sequence !== undefined) {
    const current = sequence.todo[0];
    if (current === undefined || current.kind !== kind || current.objectId !== state.sourceObjectId) {
      throw new Error('replay state does not match sequencer todo');
    }
  }
  const entries = await readIndex({ files: context.files, repository });
  const unmergedPaths = sortGitPaths({ paths: new Set(entries.filter(entry => entry.stage !== 0).map(entry => entry.path)) });
  if (unmergedPaths.length > 0) {
    for (const path of unmergedPaths)
      await context.text().print({ text: `U\t${path}\n` });
    await context.text().error({ text: 'error: Committing is not possible because you have unmerged files.\n' });
    await context.text().error({ text: 'fatal: Exiting because of an unresolved conflict.\n' });
    return { exitCode: 128 };
  }
  const created = await createReplayCommit({
    context,
    repository,
    kind,
    sourceObjectId: state.sourceObjectId,
    message: state.message,
    reflogPrefix: kind,
  });
  await clearReplayState({ files: context.files, repository, kind });
  await printReplayCommit({ context, objectId: created.objectId, subject: created.subject });
  if (sequence === undefined)
    return { exitCode: 0 };
  await advanceSequencer({ files: context.files, repository });
  return executeSequencerSteps({ context, repository, kind });
}
async function restoreReplayHead({ context, repository, objectId }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    objectId: string;
}): Promise<void> {
  const targetCommit = await readCommit({ files: context.files, repository, objectId });
  const targetEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: targetCommit.treeObjectId });
  const currentEntries = await readIndex({ files: context.files, repository });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: currentEntries,
    targetEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  await updateHead({
    files: context.files,
    repository,
    objectId,
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `reset: moving to ${objectId}`,
    },
  });
}
async function abortReplay({ context, kind }: {
    context: WeshCommandContext;
    kind: GitReplayKind;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const sequence = await readSequencerState({ files: context.files, repository });
  const state = await readReplayState({ files: context.files, repository });
  if (state !== undefined && state.kind !== kind) {
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  if (state === undefined && sequence === undefined) {
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  if (sequence !== undefined) {
    if (sequence.todo.some(entry => entry.kind !== kind))
      throw new Error('mixed sequencer kinds are not supported');
    await restoreReplayHead({ context, repository, objectId: sequence.headObjectId });
  } else {
    const head = await readHead({ files: context.files, repository });
    if (head.objectId === undefined)
      throw new Error(`cannot abort ${kind} on an unborn branch`);
    const headCommit = await readCommit({ files: context.files, repository, objectId: head.objectId });
    const headEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: headCommit.treeObjectId });
    const currentEntries = await readIndex({ files: context.files, repository });
    await forceReplaceIndexAndWorktree({
      files: context.files,
      repository,
      currentIndexEntries: currentEntries,
      targetEntries: headEntries,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
  }
  if (state !== undefined)
    await clearReplayState({ files: context.files, repository, kind });
  if (sequence !== undefined)
    await clearSequencerState({ files: context.files, repository });
  return { exitCode: 0 };
}
async function skipReplay({ context, kind }: {
    context: WeshCommandContext;
    kind: GitReplayKind;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const sequence = await readSequencerState({ files: context.files, repository });
  const state = await readReplayState({ files: context.files, repository });
  if (sequence === undefined)
    return abortReplay({ context, kind });
  const current = sequence.todo[0];
  if (current === undefined || current.kind !== kind) {
    await context.text().error({ text: `error: no ${kind} in progress\n` });
    await context.text().error({ text: `fatal: ${kind} failed\n` });
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error(`cannot skip ${kind} on an unborn branch`);
  const headCommit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  const headEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: headCommit.treeObjectId });
  const currentEntries = await readIndex({ files: context.files, repository });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: currentEntries,
    targetEntries: headEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (state !== undefined)
    await clearReplayState({ files: context.files, repository, kind });
  await advanceSequencer({ files: context.files, repository });
  return executeSequencerSteps({ context, repository, kind });
}
export type GitReplayAction = 'continue' | 'abort' | 'skip' | 'start';

export interface GitReplayRequest {
  action: GitReplayAction;
  operands: readonly string[];
  mainlineParentNumber: number | undefined;
}

export async function executeReplay({ context, request, kind }: {
    context: WeshCommandContext;
    request: GitReplayRequest;
    kind: GitReplayKind;
}): Promise<WeshCommandResult> {
  switch (request.action) {
  case 'continue':
    return continueReplay({ context, kind });
  case 'abort':
    return abortReplay({ context, kind });
  case 'skip':
    return skipReplay({ context, kind });
  case 'start':
    break;
  default: {
    const _ex: never = request.action;
    throw new Error(`Unhandled replay action: ${_ex}`);
  }
  }
  const repository = await discoverRepositoryFromContext({ context });
  if (await readMergeState({ files: context.files, repository }) !== undefined) {
    await context.text().error({ text: 'fatal: cannot replay commits while a merge is in progress\n' });
    return { exitCode: 128 };
  }
  if (await readReplayState({ files: context.files, repository }) !== undefined || await readSequencerState({ files: context.files, repository }) !== undefined) {
    await context.text().error({ text: `fatal: a ${kind} or revert is already in progress\n` });
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error(`cannot ${kind} on an unborn branch`);
  const headCommit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  let currentIndexTreeObjectId: string;
  try {
    currentIndexTreeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries: currentIndexEntries });
  } catch {
    await context.text().error({ text: `fatal: ${kind} requires a resolved index\n` });
    return { exitCode: 128 };
  }
  if (currentIndexTreeObjectId !== headCommit.treeObjectId) {
    await context.text().error({ text: `fatal: ${kind} requires the index to match HEAD\n` });
    return { exitCode: 128 };
  }
  const todo = [];
  for (const operand of request.operands) {
    const objectId = await resolveCommitRevision({ files: context.files, repository, expression: operand });
    const commit = await readCommit({ files: context.files, repository, objectId });
    todo.push({ kind, objectId, subject: commitSubject({ commit }) });
  }
  if (todo.length === 1) {
    return applyReplayObject({
      context,
      repository,
      kind,
      sourceObjectId: todo[0]!.objectId,
      mainlineParentNumber: request.mainlineParentNumber,
    });
  }
  await writeSequencerState({
    files: context.files,
    repository,
    headObjectId: head.objectId,
    todo,
    mainlineParentNumber: request.mainlineParentNumber,
  });
  return executeSequencerSteps({ context, repository, kind });
}

export const TEST_ONLY = {
};
