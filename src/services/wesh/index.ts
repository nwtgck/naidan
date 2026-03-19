import type {
  WeshCommandDefinition,
  WeshCommandResult,
  WeshIVirtualFileSystem,
  WeshCommandContext,
  WeshASTNode,
  WeshFileHandle,
  WeshCommandNode,
  WeshPipelineNode,
  WeshFileType
} from './types';
import { WeshVFS } from './vfs';
import { WeshKernel } from './kernel';
import { parseCommandLine } from './parser';
import { createTextHelpers } from './utils/io';

import { builtinCommands } from './commands';
import { helpCommandDefinition } from './commands/help';

interface WeshJob {
  id: number;
  command: string;
  pid: number;
  status: 'running' | 'done';
}

interface WeshShellState {
  env: Map<string, string>;
  cwd: string;
  fds: Map<number, WeshFileHandle>;
}

type WeshExpansionMode = 'argv' | 'assignment' | 'redirection';

interface WeshExpandedField {
  text: string;
  parts: Array<{
    text: string;
    quoted: boolean;
  }>;
}

export class Wesh {
  public vfs: WeshIVirtualFileSystem;
  public kernel: WeshKernel;

  private env: Map<string, string>;
  private cwd: string = '/';
  private history: string[] = [];
  private commands: Map<string, WeshCommandDefinition> = new Map();
  private jobs: Map<number, WeshJob> = new Map();
  private nextJobId: number = 1;
  private shellFds: Map<number, WeshFileHandle> = new Map();

  private shellPid: number = 0;

  constructor({
    rootHandle,
    user = 'user',
    initialEnv = {}
  }: {
    rootHandle: FileSystemDirectoryHandle;
    user?: string;
    initialEnv?: Record<string, string>;
  }) {
    this.vfs = new WeshVFS({ rootHandle });
    this.kernel = new WeshKernel({ vfs: this.vfs });

    this.env = new Map(Object.entries({
      HOME: '/',
      PWD: '/',
      PATH: '/bin',
      USER: user,
      SHELL: '/bin/wesh',
      ...initialEnv,
    }));

    for (const definition of builtinCommands) {
      this.registerCommand({ definition });
    }
    this.registerCommand({ definition: helpCommandDefinition });

    this.registerInternalCommand('jobs', async ({ context }) => {
      const jobs = context.getJobs();
      const { print } = context.text();
      for (const job of jobs) {
        await print({ text: `[${job.id}] ${job.status} ${job.command}\n` });
      }
      return { exitCode: 0 };
    });
  }

  async init(): Promise<void> {
    const { pid } = await this.kernel.spawn({
      image: 'wesh',
      args: ['-l'],
      env: this.env,
      cwd: this.cwd
    });
    this.shellPid = pid;
  }

  registerCommand({ definition }: { definition: WeshCommandDefinition }): void {
    this.commands.set(definition.meta.name, definition);
  }

  private registerInternalCommand(name: string, fn: ({ context }: { context: WeshCommandContext }) => Promise<WeshCommandResult>) {
    this.commands.set(name, {
      fn,
      meta: { name, description: 'Built-in command', usage: name }
    });
  }

  private parseWordParts({
    raw,
  }: {
    raw: string;
  }): Array<{
    text: string;
    quoted: boolean;
    expandVariables: boolean;
  }> {
    const parts: Array<{
      text: string;
      quoted: boolean;
      expandVariables: boolean;
    }> = [];

    let mode: 'unquoted' | 'single' | 'double' = 'unquoted';
    let current = '';

    const toPartMeta = ({
      currentMode,
    }: {
      currentMode: 'unquoted' | 'single' | 'double';
    }): {
      quoted: boolean;
      expandVariables: boolean;
    } => {
      switch (currentMode) {
      case 'unquoted':
        return {
          quoted: false,
          expandVariables: true,
        };
      case 'single':
        return {
          quoted: true,
          expandVariables: false,
        };
      case 'double':
        return {
          quoted: true,
          expandVariables: true,
        };
      default: {
        const _ex: never = currentMode;
        throw new Error(`Unhandled mode: ${_ex}`);
      }
      }
    };

    const pushCurrent = ({
      nextMode,
    }: {
      nextMode: 'unquoted' | 'single' | 'double';
    }) => {
      if (current.length === 0 && mode === nextMode) {
        return;
      }

      const meta = toPartMeta({ currentMode: mode });
      parts.push({
        text: current,
        quoted: meta.quoted,
        expandVariables: meta.expandVariables,
      });
      current = '';
      mode = nextMode;
    };

    for (let index = 0; index < raw.length; index++) {
      const char = raw[index];
      if (char === undefined) {
        continue;
      }

      const currentMode: string = mode;
      switch (currentMode) {
      case 'single':
        if (char === "'") {
          pushCurrent({ nextMode: 'unquoted' });
        } else {
          current += char;
        }
        continue;
      case 'double':
        if (char === '"') {
          pushCurrent({ nextMode: 'unquoted' });
          continue;
        }

        if (char === '\\') {
          const nextChar = raw[index + 1];
          if (nextChar !== undefined && ['\\', '"', '$'].includes(nextChar)) {
            current += nextChar;
            index += 1;
            continue;
          }
        }

        current += char;
        continue;
      case 'unquoted':
        break;
      default:
        throw new Error(`Unhandled mode: ${currentMode}`);
      }

      if (char === "'") {
        pushCurrent({ nextMode: 'single' });
        continue;
      }

      if (char === '"') {
        pushCurrent({ nextMode: 'double' });
        continue;
      }

      if (char === '\\') {
        const nextChar = raw[index + 1];
        if (nextChar !== undefined) {
          current += nextChar;
          index += 1;
          continue;
        }
      }

      current += char;
    }

    const meta = toPartMeta({ currentMode: mode });
    parts.push({
      text: current,
      quoted: meta.quoted,
      expandVariables: meta.expandVariables,
    });

    return parts;
  }

  private expandPartVariables({
    text,
    env,
  }: {
    text: string;
    env: Map<string, string>;
  }): string {
    let result = '';

    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char !== '$') {
        result += char ?? '';
        continue;
      }

      const nextChar = text[index + 1];
      if (nextChar === '?') {
        result += env.get('?') ?? '0';
        index += 1;
        continue;
      }

      if (nextChar === '{') {
        const endIndex = text.indexOf('}', index + 2);
        if (endIndex !== -1) {
          const key = text.slice(index + 2, endIndex);
          if (key === 'RANDOM') {
            result += Math.floor(Math.random() * 32768).toString();
          } else {
            result += env.get(key) ?? '';
          }
          index = endIndex;
          continue;
        }
      }

      if (nextChar !== undefined && /[A-Za-z_]/.test(nextChar)) {
        let endIndex = index + 2;
        while (endIndex < text.length && /[A-Za-z0-9_]/.test(text[endIndex] ?? '')) {
          endIndex += 1;
        }

        const key = text.slice(index + 1, endIndex);
        if (key === 'RANDOM') {
          result += Math.floor(Math.random() * 32768).toString();
        } else {
          result += env.get(key) ?? '';
        }
        index = endIndex - 1;
        continue;
      }

      result += '$';
    }

    return result;
  }

  private splitExpandedFields({
    parts,
    mode,
  }: {
    parts: Array<{
      text: string;
      quoted: boolean;
    }>;
    mode: WeshExpansionMode;
  }): WeshExpandedField[] {
    switch (mode) {
    case 'assignment':
    case 'redirection':
      return [{
        text: parts.map((part) => part.text).join(''),
        parts,
      }];
    case 'argv':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled expansion mode: ${_ex}`);
    }
    }

    const fields: WeshExpandedField[] = [];
    let currentText = '';
    let currentParts: Array<{ text: string; quoted: boolean }> = [];
    let hasContent = false;

    const flush = () => {
      if (!hasContent) {
        return;
      }

      fields.push({
        text: currentText,
        parts: currentParts,
      });
      currentText = '';
      currentParts = [];
      hasContent = false;
    };

    for (const part of parts) {
      if (part.quoted) {
        currentText += part.text;
        currentParts.push(part);
        hasContent = true;
        continue;
      }

      let chunk = '';
      for (const char of part.text) {
        if (/\s/.test(char)) {
          if (chunk.length > 0) {
            currentText += chunk;
            currentParts.push({ text: chunk, quoted: false });
            hasContent = true;
            chunk = '';
          }
          flush();
          continue;
        }
        chunk += char;
      }

      if (chunk.length > 0) {
        currentText += chunk;
        currentParts.push({ text: chunk, quoted: false });
        hasContent = true;
      }
    }

    flush();
    return fields;
  }

  private escapeGlobLiteral({
    text,
  }: {
    text: string;
  }): string {
    let result = '';
    for (const char of text) {
      if (char === '\\' || char === '*' || char === '?' || char === '[' || char === ']') {
        result += '\\';
      }
      result += char;
    }
    return result;
  }

  private hasActiveGlob({
    field,
  }: {
    field: WeshExpandedField;
  }): boolean {
    return field.parts.some((part) => !part.quoted && /[[*?]/.test(part.text));
  }

  private buildGlobPattern({
    field,
  }: {
    field: WeshExpandedField;
  }): string {
    return field.parts
      .map((part) => part.quoted ? this.escapeGlobLiteral({ text: part.text }) : part.text)
      .join('');
  }

  private compileGlobComponent({
    pattern,
  }: {
    pattern: string;
  }): RegExp {
    let source = '^';

    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === undefined) {
        continue;
      }

      if (char === '\\') {
        const nextChar = pattern[index + 1];
        if (nextChar !== undefined) {
          source += nextChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          index += 1;
          continue;
        }
        source += '\\\\';
        continue;
      }

      if (char === '*') {
        source += '[^/]*';
        continue;
      }

      if (char === '?') {
        source += '[^/]';
        continue;
      }

      if (char === '[') {
        const endIndex = pattern.indexOf(']', index + 1);
        if (endIndex !== -1) {
          let classContent = pattern.slice(index + 1, endIndex);
          if (classContent.startsWith('!')) {
            classContent = '^' + classContent.slice(1);
          }
          source += `[${classContent}]`;
          index = endIndex;
          continue;
        }
      }

      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    source += '$';
    return new RegExp(source);
  }

  private async globField({
    field,
    cwd,
  }: {
    field: WeshExpandedField;
    cwd: string;
  }): Promise<string[]> {
    if (!this.hasActiveGlob({ field })) {
      return [field.text];
    }

    const pattern = this.buildGlobPattern({ field });
    const isAbsolute = pattern.startsWith('/');
    const rawSegments = pattern.split('/').filter((segment, index) => segment.length > 0 || index > 0);
    const initialBase = isAbsolute ? '/' : cwd;
    let candidates = [initialBase];

    for (let index = 0; index < rawSegments.length; index++) {
      const segment = rawSegments[index];
      if (segment === undefined || segment.length === 0) {
        continue;
      }

      const nextCandidates: string[] = [];
      const matcher = this.compileGlobComponent({ pattern: segment });
      const segmentHasGlob = /(^|[^\\])[[*?]/.test(segment);

      for (const base of candidates) {
        if (!segmentHasGlob) {
          const candidate = base === '/' ? `/${segment}` : `${base}/${segment}`;
          try {
            await this.kernel.stat({ path: candidate });
            nextCandidates.push(candidate);
          } catch {
            continue;
          }
          continue;
        }

        let entries: Array<{ name: string; type: WeshFileType }>;
        try {
          entries = await this.kernel.readDir({ path: base });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!segment.startsWith('.') && entry.name.startsWith('.')) {
            continue;
          }
          if (!matcher.test(entry.name)) {
            continue;
          }
          nextCandidates.push(base === '/' ? `/${entry.name}` : `${base}/${entry.name}`);
        }
      }

      candidates = nextCandidates;
      if (candidates.length === 0) {
        return [field.text];
      }
      if (index < rawSegments.length - 1) {
        const directoryCandidates: string[] = [];
        for (const candidate of candidates) {
          try {
            const stat = await this.kernel.stat({ path: candidate });
            switch (stat.type) {
            case 'directory':
              directoryCandidates.push(candidate);
              break;
            case 'file':
            case 'fifo':
            case 'chardev':
            case 'symlink':
              break;
            default: {
              const _ex: never = stat.type;
              throw new Error(`Unhandled stat type: ${_ex}`);
            }
            }
          } catch {
            continue;
          }
        }
        candidates = directoryCandidates;
      }
    }

    if (candidates.length === 0) {
      return [field.text];
    }

    return candidates.map((candidate) => {
      if (isAbsolute) {
        return candidate;
      }
      if (cwd === '/') {
        return candidate.slice(1);
      }
      const prefix = `${cwd}/`;
      return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : candidate;
    });
  }

  private async expandWord({
    raw,
    env,
    cwd,
    mode,
  }: {
    raw: string;
    env: Map<string, string>;
    cwd: string;
    mode: WeshExpansionMode;
  }): Promise<string[]> {
    const parsedParts = this.parseWordParts({ raw });
    const homeDirectory = env.get('HOME') ?? '/home';
    const tildeExpandedParts = parsedParts.map((part, index) => {
      if (
        index === 0 &&
        !part.quoted &&
        part.text.startsWith('~') &&
        (part.text.length === 1 || part.text[1] === '/')
      ) {
        const suffix = part.text.slice(1);
        return {
          ...part,
          text: homeDirectory === '/' ? `/${suffix.replace(/^\/+/, '')}` : `${homeDirectory}${suffix}`,
        };
      }

      return part;
    });
    const expandedParts = tildeExpandedParts.map((part) => ({
      text: part.expandVariables ? this.expandPartVariables({ text: part.text, env }) : part.text,
      quoted: part.quoted,
    }));

    const fields = this.splitExpandedFields({ parts: expandedParts, mode });
    const expandedFields: string[] = [];

    for (const field of fields) {
      const globbed = await this.globField({ field, cwd });
      expandedFields.push(...globbed);
    }

    return expandedFields;
  }

  private async expandSingleWord({
    raw,
    env,
    cwd,
    mode,
  }: {
    raw: string;
    env: Map<string, string>;
    cwd: string;
    mode: Exclude<WeshExpansionMode, 'argv'>;
  }): Promise<string> {
    const expanded = await this.expandWord({
      raw,
      env,
      cwd,
      mode,
    });
    return expanded[0] ?? '';
  }

  private createShellFdTable({
    stdin,
    stdout,
    stderr,
  }: {
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Map<number, WeshFileHandle> {
    const fds = new Map<number, WeshFileHandle>([
      [0, stdin],
      [1, stdout],
      [2, stderr],
    ]);

    for (const [fd, handle] of this.shellFds.entries()) {
      fds.set(fd, handle);
    }

    return fds;
  }

  private async setPersistentFd({
    fd,
    handle,
  }: {
    fd: number;
    handle: WeshFileHandle;
  }): Promise<void> {
    const previous = this.shellFds.get(fd);
    if (previous !== undefined && previous !== handle) {
      await previous.close();
    }
    this.shellFds.set(fd, handle);
  }

  private async closePersistentFd({
    fd,
  }: {
    fd: number;
  }): Promise<void> {
    const previous = this.shellFds.get(fd);
    if (previous !== undefined) {
      await previous.close();
    }
    this.shellFds.delete(fd);
  }

  private async openRedirectionTarget({
    redirection,
    state,
  }: {
    redirection: WeshCommandNode['redirections'][number];
    state: WeshShellState;
  }): Promise<WeshFileHandle | undefined> {
    const rawTarget = redirection.target ? await this.expandSingleWord({
      raw: redirection.target,
      env: state.env,
      cwd: state.cwd,
      mode: 'redirection',
    }) : undefined;

    if (redirection.type === 'heredoc' || redirection.type === 'herestring') {
      if (redirection.content === undefined) {
        return undefined;
      }

      const { read, write } = await this.kernel.pipe();
      const encoder = new TextEncoder();
      const content = redirection.type === 'heredoc' && redirection.contentExpansion === 'variables'
        ? this.expandPartVariables({ text: redirection.content, env: state.env })
        : redirection.content;
      await write.write({ buffer: encoder.encode(content + '\n') });
      await write.close();
      return read;
    }

    if (redirection.type === 'dup-output' || redirection.type === 'dup-input') {
      if (redirection.closeTarget) {
        return undefined;
      }

      if (redirection.targetFd === undefined) {
        throw new Error(`Missing target fd for redirection ${redirection.type}`);
      }

      const duplicated = state.fds.get(redirection.targetFd);
      if (duplicated === undefined) {
        throw new Error(`${redirection.targetFd}: bad file descriptor`);
      }

      return duplicated;
    }

    if (rawTarget === undefined) {
      return undefined;
    }

    const fullTarget = rawTarget.startsWith('/') ? rawTarget : `${state.cwd}/${rawTarget}`;

    switch (redirection.type) {
    case 'read':
      return this.kernel.open({
        path: fullTarget,
        flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
        mode: 0o644,
      });
    case 'write':
      return this.kernel.open({
        path: fullTarget,
        flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
        mode: 0o644,
      });
    case 'append':
      return this.kernel.open({
        path: fullTarget,
        flags: { access: 'write', creation: 'if-needed', truncate: 'preserve', append: 'append' },
        mode: 0o644,
      });
    case 'read-write':
      return this.kernel.open({
        path: fullTarget,
        flags: { access: 'read-write', creation: 'if-needed', truncate: 'preserve', append: 'preserve' },
        mode: 0o644,
      });
    default: {
      const _ex: never = redirection.type;
      throw new Error(`Unhandled redirection type: ${_ex}`);
    }
    }
  }

  private async applyRedirectionsToFdTable({
    redirections,
    state,
    fdTable,
    trackOpenedHandle,
  }: {
    redirections: WeshCommandNode['redirections'];
    state: WeshShellState;
    fdTable: Map<number, WeshFileHandle>;
    trackOpenedHandle: ({ handle }: { handle: WeshFileHandle }) => void;
  }): Promise<void> {
    for (const redirection of redirections) {
      if (redirection.closeTarget) {
        const current = fdTable.get(redirection.fd);
        if (current !== undefined) {
          await current.close();
        }
        fdTable.delete(redirection.fd);
        continue;
      }

      const handle = await this.openRedirectionTarget({ redirection, state });
      if (handle === undefined) {
        continue;
      }

      if (
        redirection.type !== 'dup-output' &&
        redirection.type !== 'dup-input'
      ) {
        trackOpenedHandle({ handle });
      }

      fdTable.set(redirection.fd, handle);
    }
  }

  /**
   * Execute a shell script.
   * Low-level: All I/O goes to provided handles. Returns only exit status.
   */
  async execute(options: {
    script: string;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    if (this.shellPid === 0) await this.init();

    const script = options.script.trim();
    if (!script) {
      return { exitCode: 0 };
    }

    this.history.push(script);

    try {
      const rootNode = parseCommandLine({ commandLine: script, env: this.env });
      const state: WeshShellState = {
        env: this.env,
        cwd: this.cwd,
        fds: this.createShellFdTable({
          stdin: options.stdin,
          stdout: options.stdout,
          stderr: options.stderr,
        }),
      };

      const result = await this.executeNode({
        node: rootNode,
        state,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr
      });

      this.cwd = state.cwd;
      return result;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const encoder = new TextEncoder();
      await options.stderr.write({ buffer: encoder.encode(`wesh: ${message}\n`) });
      return { exitCode: 1 };
    }
  }

  private async executeNode(options: {
    node: WeshASTNode,
    state: WeshShellState,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, state, stdin, stdout, stderr } = options;

    switch (node.kind) {
    case 'list': {
      let lastResult: WeshCommandResult = { exitCode: 0 };
      let previousOperator: ';' | '&&' | '||' | '&' = ';';

      for (const part of node.parts) {
        let shouldExecute = true;
        if (previousOperator === '&&' && lastResult.exitCode !== 0) shouldExecute = false;
        if (previousOperator === '||' && lastResult.exitCode === 0) shouldExecute = false;

        if (!shouldExecute) {
          previousOperator = part.operator;
          continue;
        }

        switch (part.operator) {
        case '&': {
          const jobId = this.nextJobId++;
          const cmdStr = "Background Job";
          const jobState = { env: new Map(state.env), cwd: state.cwd, fds: new Map(state.fds) };

          this.executeNode({
            node: part.node,
            state: jobState,
            stdin, stdout, stderr
          }).then(res => {
            const job = this.jobs.get(jobId);
            if (job) job.status = 'done';
            return res;
          });

          this.jobs.set(jobId, {
            id: jobId,
            command: cmdStr,
            pid: 0,
            status: 'running'
          });

          // Job notification to stderr (simulating bash)
          const encoder = new TextEncoder();
          await stderr.write({ buffer: encoder.encode(`[${jobId}] background\n`) });

          lastResult = { exitCode: 0 };
          previousOperator = '&';
          break;
        }
        case ';':
        case '&&':
        case '||': {
          lastResult = await this.executeNode({
            node: part.node,
            state,
            stdin, stdout, stderr
          });
          previousOperator = part.operator;
          break;
        }
        default: {
          const _ex: never = part.operator;
          throw new Error(`Unhandled operator: ${_ex}`);
        }
        }

      }
      return lastResult;
    }

    case 'pipeline':
      return this.executePipeline({ ...options, node: node as WeshPipelineNode });

    case 'command':
      return this.executeCommand({ ...options, node: node as WeshCommandNode });

    case 'subshell': {
      const subshellState: WeshShellState = {
        env: new Map(state.env),
        cwd: state.cwd,
        fds: new Map(state.fds),
      };
      return this.executeNode({
        node: node.list,
        state: subshellState,
        stdin, stdout, stderr
      });
    }

    case 'if': {
      const conditionResult = await this.executeNode({
        node: node.condition,
        state, stdin, stdout, stderr
      });
      if (conditionResult.exitCode === 0) {
        return this.executeNode({
          node: node.thenBody,
          state, stdin, stdout, stderr
        });
      } else if (node.elseBody) {
        return this.executeNode({
          node: node.elseBody,
          state, stdin, stdout, stderr
        });
      }
      return { exitCode: 0 };
    }

    case 'for': {
      let lastForRes: WeshCommandResult = { exitCode: 0 };
      const expandedItems: string[] = [];
      for (const item of node.items) {
        const itemFields = await this.expandWord({
          raw: item,
          env: state.env,
          cwd: state.cwd,
          mode: 'argv',
        });
        expandedItems.push(...itemFields);
      }

      for (const item of expandedItems) {
        state.env.set(node.variable, item);
        lastForRes = await this.executeNode({
          node: node.body,
          state, stdin, stdout, stderr
        });
      }
      return lastForRes;
    }

    case 'assignment':
      for (const assign of node.assignments) {
        state.env.set(assign.key, await this.expandSingleWord({
          raw: assign.value,
          env: state.env,
          cwd: state.cwd,
          mode: 'assignment',
        }));
      }
      return { exitCode: 0 };
    }
  }

  private async executePipeline(options: {
    node: { commands: WeshASTNode[] },
    state: WeshShellState,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, state, stdin, stdout, stderr } = options;
    const commands = node.commands;
    if (commands.length === 0) return { exitCode: 0 };

    const pipes: Array<{ read: WeshFileHandle; write: WeshFileHandle }> = [];
    for (let i = 0; i < commands.length - 1; i++) {
      pipes.push(await this.kernel.pipe());
    }

    const promises: Promise<WeshCommandResult>[] = [];

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const myStdin = i === 0 ? stdin : pipes[i-1]!.read;
      const myStdout = i === commands.length - 1 ? stdout : pipes[i]!.write;

      const pipelineState = { env: new Map(state.env), cwd: state.cwd, fds: new Map(state.fds) };

      promises.push(
        this.executeNode({
          node: cmd,
          state: pipelineState,
          stdin: myStdin,
          stdout: myStdout,
          stderr: stderr
        }).then(async res => {
          if (i < commands.length - 1) {
            await pipes[i]!.write.close();
          }
          if (i > 0) {
            await pipes[i-1]!.read.close();
          }
          return res;
        })
      );
    }

    const results = await Promise.all(promises);
    const lastResult = results[results.length - 1]!;

    state.env.set('?', lastResult.exitCode.toString());

    return lastResult;
  }

  private async executeCommand(options: {
    node: WeshCommandNode,
    state: WeshShellState,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, state, stdin, stdout, stderr } = options;

    const expandedArgs: string[] = [];
    const procSubCleanups: Array<() => void> = [];
    const openHandles: WeshFileHandle[] = [];
    const cmdFds = new Map(state.fds);

    for (const arg of node.args) {
      if (typeof arg === 'string') {
        const fields = await this.expandWord({
          raw: arg,
          env: state.env,
          cwd: state.cwd,
          mode: 'argv',
        });
        expandedArgs.push(...fields);
      } else if (arg.kind === 'processSubstitution') {
        const { read, write } = await this.kernel.pipe();
        const id = Math.floor(Math.random() * 1000000);
        const path = `/dev/fd/${id}`;

        switch (arg.type) {
        case 'input': {
          const subState = { env: new Map(state.env), cwd: state.cwd, fds: new Map(state.fds) };
          this.executeNode({
            node: arg.list,
            state: subState,
            stdin, stdout: write, stderr
          }).then(() => write.close());

          this.vfs.registerSpecialFile({ path, handler: () => read });

          procSubCleanups.push(() => {
            this.vfs.unregisterSpecialFile({ path });
            read.close();
          });
          break;
        }
        case 'output': {
          const subState = { env: new Map(state.env), cwd: state.cwd, fds: new Map(state.fds) };
          this.executeNode({
            node: arg.list,
            state: subState,
            stdin: read, stdout, stderr
          }).then(() => read.close());

          this.vfs.registerSpecialFile({ path, handler: () => write });
          procSubCleanups.push(() => {
            this.vfs.unregisterSpecialFile({ path });
            write.close();
          });
          break;
        }
        default: {
          const _ex: never = arg.type;
          throw new Error(`Unhandled process substitution type: ${_ex}`);
        }
        }
        expandedArgs.push(path);
      }
    }

    const cmdName = await this.expandSingleWord({
      raw: node.name,
      env: state.env,
      cwd: state.cwd,
      mode: 'assignment',
    });
    const definition = this.commands.get(cmdName);

    if (!definition) {
      throw new Error(`Command not found: ${cmdName}`);
    }

    const currentEnv = new Map(state.env);
    for (const assign of node.assignments) {
      currentEnv.set(assign.key, await this.expandSingleWord({
        raw: assign.value,
        env: state.env,
        cwd: state.cwd,
        mode: 'assignment',
      }));
    }

    cmdFds.set(0, stdin);
    cmdFds.set(1, stdout);
    cmdFds.set(2, stderr);

    await this.applyRedirectionsToFdTable({
      redirections: node.redirections,
      state,
      fdTable: cmdFds,
      trackOpenedHandle: ({ handle }) => {
        openHandles.push(handle);
      },
    });

    const cmdStdin = cmdFds.get(0);
    const cmdStdout = cmdFds.get(1);
    const cmdStderr = cmdFds.get(2);

    if (cmdStdin === undefined || cmdStdout === undefined || cmdStderr === undefined) {
      throw new Error('Missing standard file descriptor after redirection');
    }

    const { pid, process: proc } = await this.kernel.spawn({
      image: cmdName,
      args: expandedArgs,
      env: currentEnv,
      cwd: state.cwd,
      fds: cmdFds
    });

    const context: WeshCommandContext = {
      args: expandedArgs,
      env: currentEnv,
      cwd: state.cwd,
      pid: pid,
      kernel: this.kernel,
      stdin: cmdStdin,
      stdout: cmdStdout,
      stderr: cmdStderr,
      setCwd: ({ path }: { path: string }) => {
        state.env.set('OLDPWD', state.cwd);
        state.cwd = path;
        state.env.set('PWD', path);
      },
      setEnv: ({ key, value }: { key: string; value: string }) => {
        state.env.set(key, value);
      },
      unsetEnv: ({ key }: { key: string }) => {
        state.env.delete(key);
      },
      getHistory: () => [...this.history],
      getWeshCommandMeta: ({ name }: { name: string }) => this.commands.get(name)?.meta,
      getCommandNames: () => Array.from(this.commands.keys()),
      getJobs: () => Array.from(this.jobs.values()).map(j => ({ id: j.id, command: j.command, status: j.status })),
      executeCommand: ({ command, args, stdin: nextStdin, stdout: nextStdout, stderr: nextStderr }) => this.executeArgv({
        command,
        args,
        state,
        stdin: nextStdin ?? cmdStdin,
        stdout: nextStdout ?? cmdStdout,
        stderr: nextStderr ?? cmdStderr,
      }),
      executeShell: ({ script, stdin: nextStdin, stdout: nextStdout, stderr: nextStderr }) => this.executeShellInState({
        script,
        state,
        stdin: nextStdin ?? cmdStdin,
        stdout: nextStdout ?? cmdStdout,
        stderr: nextStderr ?? cmdStderr,
      }),
      getFileDescriptors: () => Array.from(proc.fds.entries()),
      getFileDescriptor: ({ fd }) => proc.fds.get(fd),
      setFileDescriptor: async ({ fd, handle, persist }) => {
        proc.fds.set(fd, handle);
        state.fds.set(fd, handle);
        if (persist) {
          await this.setPersistentFd({ fd, handle });
        }
      },
      closeFileDescriptor: async ({ fd, persist }) => {
        const current = proc.fds.get(fd);
        if (current !== undefined) {
          await current.close();
        }
        proc.fds.delete(fd);
        state.fds.delete(fd);
        if (persist) {
          await this.closePersistentFd({ fd });
        }
      },
      text: () => createTextHelpers({ stdin: cmdStdin, stdout: cmdStdout, stderr: cmdStderr }),
    };

    try {
      const result = await definition.fn({ context });
      proc.state = 'terminated';
      proc.exitCode = result.exitCode;
      return result;
    } finally {
      for (const h of openHandles) {
        await h.close();
      }
      for (const c of procSubCleanups) c();
    }
  }

  private async executeArgv(options: {
    command: string;
    args: string[];
    state: WeshShellState;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    const isolatedState: WeshShellState = {
      env: new Map(options.state.env),
      cwd: options.state.cwd,
      fds: new Map(options.state.fds),
    };

    return this.executeCommand({
      node: {
        kind: 'command',
        assignments: [],
        name: options.command,
        args: options.args,
        redirections: [],
      },
      state: isolatedState,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
    });
  }

  private async executeShellInState(options: {
    script: string;
    state: WeshShellState;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    const rootNode = parseCommandLine({
      commandLine: options.script,
      env: options.state.env,
    });

    return this.executeNode({
      node: rootNode,
      state: options.state,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
    });
  }
}
