import { idToRaw, toWorkflowId, type WorkflowId, type WorkflowRunId } from '@/01-models/ids';
import type { WorkflowDocument, WorkflowRunRecord } from '@/01-models/workflow';
import { ExperimentalWorkflowDtoSchema, ExperimentalWorkflowRunDtoSchema } from './00-dto/experimental-workflow.dto';
import { workflowDocumentToDomain, workflowDocumentToDto, workflowRunToDomain, workflowRunToDto } from './mapper/workflow';
import { workflowJsonFormat } from './workflow-json';
import type { FileLocation, WriteFileText } from './file-record';

const rawIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const suffix = '.json';

function matchesName({ name }: { name: string }): boolean {
  return name.endsWith(suffix) && rawIdPattern.test(name.slice(0, -suffix.length));
}

function recordName({ rawId, error }: { rawId: string, error: string }): string {
  if (!rawIdPattern.test(rawId)) {
    throw new Error(error);
  }
  return rawId + suffix;
}

export type ReadWorkflowFile = ({ file, read }: {
  file: FileLocation, read({ contents }: { contents: Pick<Blob, 'size' | 'text'> }): Promise<string>,
}) => Promise<string | undefined>;

function workflowFile<T>({ parent, name, assertFileSize, decode }: {
  parent: readonly string[], name: string, decode: ({ source, name }: { source: string, name: string }) => T,
  assertFileSize({ bytes }: { bytes: number }): void,
}) {
  const file: FileLocation = { name, path: [...parent, name] };
  const fromSource = ({ source }: { source: string }) => decode({ source, name });
  // Conflict checks compare the saved source before decoding it.
  const readSource = ({ readFile }: { readFile: ReadWorkflowFile }) => readFile({
    file,
    read({ contents }) {
      assertFileSize({ bytes: contents.size });
      return contents.text();
    },
  });
  return {
    file,
    decode: fromSource,
    async read({ readFile }: { readFile: ReadWorkflowFile }): Promise<T | undefined> {
      const source = await readSource({ readFile });
      return source === undefined ? undefined : fromSource({ source });
    },
    readSource,
  };
}

function documentName({ rawId }: { rawId: string }): string {
  return recordName({ rawId, error: 'Invalid Workflow document ID.' });
}

export function createWorkflowDocumentFormat({ parent }: { parent: readonly string[] }) {
  function assertFileSize({ bytes }: { bytes: number }): void {
    if (bytes > workflowJsonFormat.maxBytes) {
      throw new Error('Workflow document is too large to load.');
    }
  }

  function decode({ source, name }: { source: string, name: string }): { document: WorkflowDocument, source: string } {
    const dto = ExperimentalWorkflowDtoSchema.parse(workflowJsonFormat.toDto({ text: source }));
    if (documentName({ rawId: idToRaw({ id: toWorkflowId({ raw: dto.id }) }) }) !== name) {
      throw new Error('Workflow document identity does not match its file.');
    }
    return { document: workflowDocumentToDomain({ dto }), source };
  }

  const bindFile = ({ name }: { name: string }) => workflowFile({ parent, name, assertFileSize, decode });
  return {
    file({ id }: { id: WorkflowId }) {
      return bindFile({ name: documentName({ rawId: idToRaw({ id }) }) });
    },
    listedFile({ name }: { name: string }) {
      return matchesName({ name }) ? bindFile({ name }) : undefined;
    },
    prepareWrite({ document }: { document: WorkflowDocument }) {
      const dto = ExperimentalWorkflowDtoSchema.parse(workflowDocumentToDto({ domain: document }));
      const source = JSON.stringify(dto);
      workflowJsonFormat.toDto({ text: source });
      const target = bindFile({ name: documentName({ rawId: idToRaw({ id: document.id }) }) });
      return {
        target,
        async write({ writeText }: { writeText: WriteFileText }) {
          await writeText({ file: target.file, text: source });
          return target.decode({ source });
        },
      };
    },
  };
}

const runMaxBytes = 8 * 1024 * 1024;

function runName({ rawId }: { rawId: string }): string {
  return recordName({ rawId, error: 'Invalid Workflow run ID.' });
}

function assertRunFileSize({ bytes }: { bytes: number }): void {
  if (bytes > runMaxBytes) {
    throw new Error('Workflow history record is too large.');
  }
}

export function createWorkflowRunFormat({ parent, matchesResultsPath }: {
  parent: readonly string[],
  matchesResultsPath: ({ path }: { path: readonly string[] }) => boolean,
}) {
  function validate({ record }: { record: WorkflowRunRecord }): void {
    const terminal = record.status !== 'running';
    if (!Number.isSafeInteger(record.startedAt) || record.startedAt < 0 || terminal !== (record.finishedAt !== undefined)
      || (record.finishedAt !== undefined && (!Number.isSafeInteger(record.finishedAt) || record.finishedAt < record.startedAt))) {
      throw new Error('Invalid Workflow run timestamps.');
    }
    if (record.checkpointAt !== undefined && (!Number.isSafeInteger(record.checkpointAt) || record.checkpointAt < record.startedAt
      || (record.finishedAt !== undefined && record.checkpointAt > record.finishedAt))) {
      throw new Error('Invalid Workflow checkpoint timestamp.');
    }
    if (record.ownership === 'web_lock' && record.checkpointAt === undefined) {
      throw new Error('Owned Workflow history requires a checkpoint timestamp.');
    }
    if (record.entries.length > 200 || record.entries.some(entry => !Number.isSafeInteger(entry.number) || entry.number < 1 || entry.trace.length > 32
      || entry.trace.some(index => !Number.isSafeInteger(index) || index < 0) || entry.preview.length > 4096 || entry.inputPreview.length > 4096)) {
      throw new Error('Workflow history preview limit exceeded.');
    }
    if (record.resultsPath !== undefined && !matchesResultsPath({ path: record.resultsPath })) {
      throw new Error('Workflow results must belong to a temporary results directory.');
    }
  }

  function decode({ source, name }: { source: string, name: string }): { record: WorkflowRunRecord, source: string } {
    assertRunFileSize({ bytes: new TextEncoder().encode(source).byteLength });
    const value: unknown = JSON.parse(source);
    // History uses JSON.parse for the envelope, so duplicate keys resolve to the
    // last value. Bound the surviving recursive definition before DTO validation.
    if (!value || typeof value !== 'object' || !('definition' in value)) {
      throw new Error('Workflow history definition is missing.');
    }
    workflowJsonFormat.toDto({ text: JSON.stringify(value.definition) });
    const record = workflowRunToDomain({ dto: ExperimentalWorkflowRunDtoSchema.parse(value) });
    if (runName({ rawId: idToRaw({ id: record.id }) }) !== name) {
      throw new Error('Workflow run identity does not match its file.');
    }
    validate({ record });
    return { record, source };
  }

  const bindFile = ({ name }: { name: string }) => workflowFile({ parent, name, assertFileSize: assertRunFileSize, decode });
  return {
    file({ id }: { id: WorkflowRunId }) {
      return bindFile({ name: runName({ rawId: idToRaw({ id }) }) });
    },
    listedFile({ name }: { name: string }) {
      return matchesName({ name }) ? bindFile({ name }) : undefined;
    },
    prepareWrite({ record }: { record: WorkflowRunRecord }) {
      const source = JSON.stringify(workflowRunToDto({ domain: record }));
      const target = bindFile({ name: runName({ rawId: idToRaw({ id: record.id }) }) });
      const snapshot = target.decode({ source });
      return {
        target,
        async write({ writeText }: { writeText: WriteFileText }) {
          await writeText({ file: target.file, text: source });
          return snapshot;
        },
      };
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
