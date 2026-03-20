import type {
  WeshCommandDefinition,
  WeshCommandResult,
  WeshIVirtualFileSystem,
  WeshCommandContext,
  WeshASTNode,
  WeshFileHandle,
  WeshCommandNode,
  WeshPipelineNode,
  WeshFileType,
} from './types';
import { weshWaitStatusToExitCode } from './types';
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

interface WeshExecutionEnvironment {
  shellPid: number;
  pgid: number;
  env: Map<string, string>;
  cwd: string;
  fds: Map<number, WeshFileHandle>;
  traps: Map<string, string>;
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
  private traps: Map<string, string> = new Map();

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
      cwd: this.cwd,
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
        const expansion = this.expandBracedParameter({
          text,
          startIndex: index,
          env,
        });
        result += expansion.value;
        index = expansion.endIndex;
        continue;
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

  private expandBracedParameter({
    text,
    startIndex,
    env,
  }: {
    text: string;
    startIndex: number;
    env: Map<string, string>;
  }): {
    value: string;
    endIndex: number;
  } {
    const endIndex = text.indexOf('}', startIndex + 2);
    if (endIndex === -1) {
      return {
        value: '$',
        endIndex: startIndex,
      };
    }

    const expression = text.slice(startIndex + 2, endIndex);
    const expansionValue = this.evaluateParameterExpansion({
      expression,
      env,
    });
    return {
      value: expansionValue,
      endIndex,
    };
  }

  private evaluateParameterExpansion({
    expression,
    env,
  }: {
    expression: string;
    env: Map<string, string>;
  }): string {
    if (expression.length === 0) {
      return '';
    }

    if (expression.startsWith('#')) {
      const name = expression.slice(1);
      return this.getParameterValue({
        name,
        env,
      }).length.toString();
    }

    const operatorMatch = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(:?[-=?+])(.*)$/);
    if (operatorMatch !== null) {
      const name = operatorMatch[1]!;
      const operator = operatorMatch[2]!;
      const operand = operatorMatch[3] ?? '';
      return this.evaluateParameterOperator({
        name,
        operator,
        operand,
        env,
      });
    }

    return this.getParameterValue({
      name: expression,
      env,
    });
  }

  private evaluateParameterOperator({
    name,
    operator,
    operand,
    env,
  }: {
    name: string;
    operator: string;
    operand: string;
    env: Map<string, string>;
  }): string {
    const currentValue = env.get(name);
    const isSet = currentValue !== undefined;
    const isNull = currentValue === '';
    const requireNonNull = operator.startsWith(':');
    const shouldUseOperand = requireNonNull ? !isSet || isNull : !isSet;
    const expandedOperand = this.expandPartVariables({
      text: operand,
      env,
    });

    switch (operator) {
    case ':-':
    case '-':
      return shouldUseOperand ? expandedOperand : currentValue ?? '';
    case ':=':
    case '=':
      if (shouldUseOperand) {
        env.set(name, expandedOperand);
        return expandedOperand;
      }
      return currentValue ?? '';
    case ':+':
    case '+':
      return shouldUseOperand ? '' : expandedOperand;
    case ':?':
    case '?':
      if (shouldUseOperand) {
        throw new Error(expandedOperand.length > 0 ? `${name}: ${expandedOperand}` : `${name}: parameter null or not set`);
      }
      return currentValue ?? '';
    default:
      return currentValue ?? '';
    }
  }

  private getParameterValue({
    name,
    env,
  }: {
    name: string;
    env: Map<string, string>;
  }): string {
    if (name === 'RANDOM') {
      return Math.floor(Math.random() * 32768).toString();
    }
    return env.get(name) ?? '';
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
    environment,
  }: {
    redirection: WeshCommandNode['redirections'][number];
    environment: WeshExecutionEnvironment;
  }): Promise<WeshFileHandle | undefined> {
    const rawTarget = redirection.target ? await this.expandSingleWord({
      raw: redirection.target,
      env: environment.env,
      cwd: environment.cwd,
      mode: 'redirection',
    }) : undefined;

    if (redirection.type === 'heredoc' || redirection.type === 'herestring') {
      if (redirection.content === undefined) {
        return undefined;
      }

      const { read, write } = await this.kernel.pipe();
      const encoder = new TextEncoder();
      const content = redirection.type === 'heredoc' && redirection.contentExpansion === 'variables'
        ? this.expandPartVariables({ text: redirection.content, env: environment.env })
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

      const duplicated = environment.fds.get(redirection.targetFd);
      if (duplicated === undefined) {
        throw new Error(`${redirection.targetFd}: bad file descriptor`);
      }

      return duplicated;
    }

    if (rawTarget === undefined) {
      return undefined;
    }

    const fullTarget = rawTarget.startsWith('/') ? rawTarget : `${environment.cwd}/${rawTarget}`;

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
    environment,
    fdTable,
    trackOpenedHandle,
  }: {
    redirections: WeshCommandNode['redirections'];
    environment: WeshExecutionEnvironment;
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

      const handle = await this.openRedirectionTarget({ redirection, environment });
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
      const environment = this.createExecutionEnvironment({
        shellPid: this.shellPid,
        pgid: this.shellPid,
        env: this.env,
        cwd: this.cwd,
        fds: this.createShellFdTable({
          stdin: options.stdin,
          stdout: options.stdout,
          stderr: options.stderr,
        }),
        traps: this.traps,
      });

      const result = await this.executeNode({
        node: rootNode,
        environment,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr
      });

      this.cwd = environment.cwd;
      return await this.runExitTrapIfNeeded({
        result,
        environment,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const encoder = new TextEncoder();
      await options.stderr.write({ buffer: encoder.encode(`wesh: ${message}\n`) });
      return { exitCode: 1 };
    }
  }

  private async executeNode(options: {
    node: WeshASTNode,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, environment, stdin, stdout, stderr } = options;
    let result: WeshCommandResult;

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
          const jobEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            pgid: undefined,
          });

          this.executeNode({
            node: part.node,
            environment: jobEnvironment,
            stdin, stdout, stderr
          }).then(res => {
            const job = this.jobs.get(jobId);
            if (job) job.status = 'done';
            return res;
          });

          this.jobs.set(jobId, {
            id: jobId,
            command: cmdStr,
            pid: jobEnvironment.shellPid,
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
            environment,
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
      result = lastResult;
      break;
    }

    case 'pipeline': {
      result = await this.executePipeline({ ...options, node: node as WeshPipelineNode });
      break;
    }

    case 'command': {
      result = await this.executeCommand({ ...options, node: node as WeshCommandNode });
      break;
    }

    case 'subshell': {
      const subshellEnvironment = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        pgid: undefined,
      });
      result = await this.executeNode({
        node: node.list,
        environment: subshellEnvironment,
        stdin, stdout, stderr
      });
      result = await this.runExitTrapIfNeeded({
        result,
        environment: subshellEnvironment,
        stdin,
        stdout,
        stderr,
      });
      break;
    }

    case 'if': {
      const conditionResult = await this.executeNode({
        node: node.condition,
        environment, stdin, stdout, stderr
      });
      if (conditionResult.exitCode === 0) {
        result = await this.executeNode({
          node: node.thenBody,
          environment, stdin, stdout, stderr
        });
      } else if (node.elseBody) {
        result = await this.executeNode({
          node: node.elseBody,
          environment, stdin, stdout, stderr
        });
      } else {
        result = { exitCode: 0 };
      }
      break;
    }

    case 'for': {
      let lastForRes: WeshCommandResult = { exitCode: 0 };
      const expandedItems: string[] = [];
      for (const item of node.items) {
        const itemFields = await this.expandWord({
          raw: item,
          env: environment.env,
          cwd: environment.cwd,
          mode: 'argv',
        });
        expandedItems.push(...itemFields);
      }

      for (const item of expandedItems) {
        environment.env.set(node.variable, item);
        lastForRes = await this.executeNode({
          node: node.body,
          environment, stdin, stdout, stderr
        });
      }
      result = lastForRes;
      break;
    }

    case 'assignment':
      for (const assign of node.assignments) {
        environment.env.set(assign.key, await this.expandSingleWord({
          raw: assign.value,
          env: environment.env,
          cwd: environment.cwd,
          mode: 'assignment',
        }));
      }
      result = { exitCode: 0 };
      break;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled AST node kind: ${JSON.stringify(_ex)}`);
    }
    }

    environment.env.set('?', result.exitCode.toString());
    return result;
  }

  private async executePipeline(options: {
    node: { commands: WeshASTNode[] },
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, environment, stdin, stdout, stderr } = options;
    const commands = node.commands;
    if (commands.length === 0) return { exitCode: 0 };

    const pipes: Array<{ read: WeshFileHandle; write: WeshFileHandle }> = [];
    for (let i = 0; i < commands.length - 1; i++) {
      pipes.push(await this.kernel.pipe());
    }

    const promises: Promise<WeshCommandResult>[] = [];
    let pipelinePgid: number | undefined;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const myStdin = i === 0 ? stdin : pipes[i-1]!.read;
      const myStdout = i === commands.length - 1 ? stdout : pipes[i]!.write;

      const pipelineEnvironment = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        pgid: pipelinePgid,
      });
      pipelinePgid = pipelineEnvironment.pgid;

      promises.push(
        this.executeNode({
          node: cmd,
          environment: pipelineEnvironment,
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
    return results[results.length - 1]!;
  }

  private async executeCommand(options: {
    node: WeshCommandNode,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, environment, stdin, stdout, stderr } = options;

    const expandedArgs: string[] = [];
    const procSubCleanups: Array<() => void> = [];
    const openHandles: WeshFileHandle[] = [];
    const cmdFds = new Map(environment.fds);

    for (const arg of node.args) {
      if (typeof arg === 'string') {
        const fields = await this.expandWord({
          raw: arg,
          env: environment.env,
          cwd: environment.cwd,
          mode: 'argv',
        });
        expandedArgs.push(...fields);
      } else if (arg.kind === 'processSubstitution') {
        const { read, write } = await this.kernel.pipe();
        const id = Math.floor(Math.random() * 1000000);
        const path = `/dev/fd/${id}`;

        switch (arg.type) {
        case 'input': {
          const subEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            pgid: environment.pgid,
          });
          this.executeNode({
            node: arg.list,
            environment: subEnvironment,
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
          const subEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            pgid: environment.pgid,
          });
          this.executeNode({
            node: arg.list,
            environment: subEnvironment,
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
      env: environment.env,
      cwd: environment.cwd,
      mode: 'assignment',
    });
    const definition = this.commands.get(cmdName);

    if (!definition) {
      throw new Error(`Command not found: ${cmdName}`);
    }

    const currentEnv = new Map(environment.env);
    for (const assign of node.assignments) {
      currentEnv.set(assign.key, await this.expandSingleWord({
        raw: assign.value,
        env: environment.env,
        cwd: environment.cwd,
        mode: 'assignment',
      }));
    }

    cmdFds.set(0, stdin);
    cmdFds.set(1, stdout);
    cmdFds.set(2, stderr);

    await this.applyRedirectionsToFdTable({
      redirections: node.redirections,
      environment,
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
      cwd: environment.cwd,
      fds: cmdFds,
      ppid: environment.shellPid,
      pgid: environment.pgid,
    });

    proc.fds = this.kernel.bindFdTable({
      pid,
      fdTable: proc.fds,
    });

    const boundStdin = proc.fds.get(0);
    const boundStdout = proc.fds.get(1);
    const boundStderr = proc.fds.get(2);

    if (boundStdin === undefined || boundStdout === undefined || boundStderr === undefined) {
      throw new Error('Missing standard file descriptor after process binding');
    }

    const context: WeshCommandContext = {
      args: expandedArgs,
      env: currentEnv,
      cwd: environment.cwd,
      pid: pid,
      kernel: this.kernel,
      stdin: boundStdin,
      stdout: boundStdout,
      stderr: boundStderr,
      setCwd: ({ path }: { path: string }) => {
        environment.env.set('OLDPWD', environment.cwd);
        environment.cwd = path;
        environment.env.set('PWD', path);
      },
      setEnv: ({ key, value }: { key: string; value: string }) => {
        environment.env.set(key, value);
      },
      unsetEnv: ({ key }: { key: string }) => {
        environment.env.delete(key);
      },
      getHistory: () => [...this.history],
      getWeshCommandMeta: ({ name }: { name: string }) => this.commands.get(name)?.meta,
      getCommandNames: () => Array.from(this.commands.keys()),
      resolveCommand: ({ name }) => {
        const meta = this.commands.get(name)?.meta;
        if (meta !== undefined) {
          return {
            kind: 'builtin',
            name,
            meta,
          };
        }

        return {
          kind: 'not-found',
          name,
        };
      },
      getJobs: () => Array.from(this.jobs.values()).map(j => ({ id: j.id, command: j.command, status: j.status })),
      executeCommand: ({ command, args, stdin: nextStdin, stdout: nextStdout, stderr: nextStderr }) => this.executeArgv({
        command,
        args,
        environment,
        stdin: nextStdin ?? boundStdin,
        stdout: nextStdout ?? boundStdout,
        stderr: nextStderr ?? boundStderr,
      }),
      executeShell: ({ script, stdin: nextStdin, stdout: nextStdout, stderr: nextStderr }) => this.executeShellInState({
        script,
        environment,
        stdin: nextStdin ?? boundStdin,
        stdout: nextStdout ?? boundStdout,
        stderr: nextStderr ?? boundStderr,
      }),
      getFileDescriptors: () => Array.from(proc.fds.entries()),
      getFileDescriptor: ({ fd }) => proc.fds.get(fd),
      setFileDescriptor: async ({ fd, handle, persist }) => {
        const boundHandle = this.kernel.bindFileHandle({
          pid,
          handle,
        });
        proc.fds.set(fd, boundHandle);
        environment.fds.set(fd, boundHandle);
        if (persist) {
          await this.setPersistentFd({ fd, handle: boundHandle });
        }
      },
      closeFileDescriptor: async ({ fd, persist }) => {
        const current = proc.fds.get(fd);
        if (current !== undefined) {
          await current.close();
        }
        proc.fds.delete(fd);
        environment.fds.delete(fd);
        if (persist) {
          await this.closePersistentFd({ fd });
        }
      },
      setTrap: ({ condition, action }) => {
        if (action === undefined) {
          environment.traps.delete(condition);
          return;
        }
        environment.traps.set(condition, action);
      },
      getTrapAction: ({ condition }) => {
        return environment.traps.get(condition);
      },
      getTraps: () => {
        return Array.from(environment.traps.entries())
          .sort(([leftCondition], [rightCondition]) => leftCondition.localeCompare(rightCondition));
      },
      text: () => createTextHelpers({ stdin: boundStdin, stdout: boundStdout, stderr: boundStderr }),
    };

    try {
      const result = await definition.fn({ context });
      proc.state = 'terminated';
      proc.waitStatus = result.waitStatus ?? {
        kind: 'exited',
        exitCode: result.exitCode,
      };
      proc.exitCode = result.exitCode;
      return result;
    } catch (error: unknown) {
      if (proc.waitStatus?.kind === 'signaled' || proc.waitStatus?.kind === 'stopped') {
        // TODO(wesh-signal): Remove this temporary exception-based bridge once
        // process-bound handles can interrupt command execution without throwing
        // through JS catch paths and kernel waitStatus is the only signal source.
        const signalWaitStatus = proc.waitStatus;
        return {
          exitCode: weshWaitStatusToExitCode({
            waitStatus: signalWaitStatus,
          }),
          waitStatus: signalWaitStatus,
        };
      }
      throw error;
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
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    const isolatedEnvironment = await this.spawnChildExecutionEnvironment({
      parentEnvironment: options.environment,
      pgid: options.environment.pgid,
    });

    return this.executeCommand({
      node: {
        kind: 'command',
        assignments: [],
        name: options.command,
        args: options.args,
        redirections: [],
      },
      environment: isolatedEnvironment,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
    });
  }

  private createExecutionEnvironment({
    shellPid,
    pgid,
    env,
    cwd,
    fds,
    traps,
  }: {
    shellPid: number;
    pgid: number;
    env: Map<string, string>;
    cwd: string;
    fds: Map<number, WeshFileHandle>;
    traps: Map<string, string>;
  }): WeshExecutionEnvironment {
    return {
      shellPid,
      pgid,
      env,
      cwd,
      fds,
      traps,
    };
  }

  private cloneExecutionEnvironment({
    environment,
    shellPid,
    pgid,
  }: {
    environment: WeshExecutionEnvironment;
    shellPid: number | undefined;
    pgid: number | undefined;
  }): WeshExecutionEnvironment {
    return this.createExecutionEnvironment({
      shellPid: shellPid ?? environment.shellPid,
      pgid: pgid ?? environment.pgid,
      env: new Map(environment.env),
      cwd: environment.cwd,
      fds: new Map(environment.fds),
      traps: new Map(environment.traps),
    });
  }

  private async spawnChildExecutionEnvironment({
    parentEnvironment,
    pgid,
  }: {
    parentEnvironment: WeshExecutionEnvironment;
    pgid: number | undefined;
  }): Promise<WeshExecutionEnvironment> {
    const childEnvironment = this.cloneExecutionEnvironment({
      environment: parentEnvironment,
      shellPid: undefined,
      pgid,
    });

    const { pid } = await this.kernel.spawn({
      image: 'wesh',
      args: ['-c'],
      env: childEnvironment.env,
      cwd: childEnvironment.cwd,
      fds: new Map(childEnvironment.fds),
      ppid: parentEnvironment.shellPid,
      pgid: pgid,
    });

    childEnvironment.shellPid = pid;
    childEnvironment.pgid = pgid ?? pid;
    return childEnvironment;
  }

  private async runExitTrapIfNeeded(options: {
    result: WeshCommandResult;
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    const exitTrap = options.environment.traps.get('EXIT');
    if (exitTrap === undefined) {
      return options.result;
    }

    // TODO(wesh-trap): Preserve shell-compatible $? during trap execution and align
    // signal-triggered EXIT behavior with process waitStatus once trap dispatch is
    // integrated with the kernel-level signal model.
    await this.executeShellInState({
      script: exitTrap,
      environment: options.environment,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
    });
    return options.result;
  }

  private async executeShellInState(options: {
    script: string;
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    const rootNode = parseCommandLine({
      commandLine: options.script,
      env: options.environment.env,
    });

    return this.executeNode({
      node: rootNode,
      environment: options.environment,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
    });
  }
}
