import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { getBooleanConfigValue, readEffectiveConfig } from './config';
import { resolveGitIdentity, resolveGitTimestamp } from './identity';
import { readObject, writeObject } from './objects';
import { createRef, deleteRef, listRefs, readRef } from './refs';
import { discoverRepositoryFromContext } from './repository';
import { resolveRevision } from './revision';
import { compareGitUtf8Strings } from './utf8-order';

const textEncoder = new TextEncoder();

function tagObjectType({ type }: { type: 'blob' | 'tree' | 'commit' | 'tag' }): string {
  switch (type) {
  case 'blob':
  case 'tree':
  case 'commit':
  case 'tag':
    return type;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled tag target type: ${_ex}`);
  }
  }
}

async function createAnnotatedTag({ context, name, targetObjectId, message }: {
  context: WeshCommandContext,
  name: string,
  targetObjectId: string,
  message: string,
}): Promise<string> {
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const identity = resolveGitIdentity({ env: context.env, config, role: 'COMMITTER' });
  const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  const target = await readObject({ files: context.files, repository, objectId: targetObjectId });
  const normalizedMessage = message.endsWith('\n') ? message : `${message}\n`;
  const body = textEncoder.encode([
    `object ${targetObjectId}`,
    `type ${tagObjectType({ type: target.type })}`,
    `tag ${name}`,
    `tagger ${identity.name} <${identity.email}> ${timestamp}`,
    '',
    normalizedMessage,
  ].join('\n'));
  return writeObject({ files: context.files, repository, type: 'tag', body });
}

export async function runTag({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let annotated = false;
  let deleteMode = false;
  let message: string | undefined;
  let parsingOptions = true;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-a' || arg === '--annotate')) annotated = true;
    else if (parsingOptions && (arg === '-d' || arg === '--delete')) deleteMode = true;
    else if (parsingOptions && (arg === '-m' || arg === '--message')) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a value`);
      message = value;
      annotated = true;
      index += 1;
    } else if (parsingOptions && arg.startsWith('-')) throw new Error(`unsupported tag argument: ${arg}`);
    else operands.push(arg);
  }

  const repository = await discoverRepositoryFromContext({ context });
  if (deleteMode) {
    if (annotated || message !== undefined) throw new Error('tag delete cannot be combined with annotation options');
    if (operands.length === 0) throw new Error('tag name required');
    for (const name of operands) {
      const refName = `refs/tags/${name}`;
      const oldObjectId = await readRef({ files: context.files, repository, refName });
      if (oldObjectId === undefined) throw new Error(`tag '${name}' not found.`);
      await deleteRef({ files: context.files, repository, refName });
      await context.text().print({ text: `Deleted tag '${name}' (was ${oldObjectId.slice(0, 7)})\n` });
    }
    return { exitCode: 0 };
  }

  if (operands.length === 0) {
    if (annotated || message !== undefined) throw new Error('tag name required');
    const refs = await listRefs({ files: context.files, repository, prefix: 'refs/tags' });
    for (const ref of refs.sort((left, right) => compareGitUtf8Strings({ left: left.refName, right: right.refName }))) {
      await context.text().print({ text: `${ref.refName.slice('refs/tags/'.length)}\n` });
    }
    return { exitCode: 0 };
  }
  if (operands.length > 2) throw new Error('too many arguments');
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    env: context.env,
  });
  if (getBooleanConfigValue({ config, key: 'tag.gpgsign' }) === true) {
    throw new Error('tag signing is not supported yet');
  }
  const name = operands[0]!;
  const refName = `refs/tags/${name}`;
  if (await readRef({ files: context.files, repository, refName }) !== undefined) {
    throw new Error(`tag '${name}' already exists`);
  }
  if (annotated && message === undefined) {
    throw new Error('annotated tag message editor is not supported; use -m <message>');
  }
  const targetObjectId = await resolveRevision({
    files: context.files,
    repository,
    expression: operands[1] ?? 'HEAD',
  });
  const refObjectId = annotated
    ? await createAnnotatedTag({ context, name, targetObjectId, message: message! })
    : targetObjectId;
  await createRef({ files: context.files, repository, refName, objectId: refObjectId });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
