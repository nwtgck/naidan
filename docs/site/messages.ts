import { z } from 'zod';

const text = z.string().min(1).refine(value => value.trim().length > 0, 'Expected non-blank text');
const paragraph = z.array(text).min(1);
const section = z.strictObject({ title: text, body: text });
export const commonMessagesSchema = z.strictObject({
  skip: text,
  home: text,
  guides: text,
  source: text,
  launch: text,
  lightTheme: text,
  pauseMotion: text,
  resumeMotion: text,
  footer: text,
  back: text,
});
export type CommonMessages = z.infer<typeof commonMessagesSchema>;

const basic = z.strictObject({ title: text, description: text, intro: paragraph });
export const homeMessagesSchema = basic.extend({
  headline: z.tuple([text, text]),
  mock: text,
  howTitle: text,
  howLead: text,
  mechanisms: z.tuple([section, section, section]),
  boundaryNote: text,
  modelsTitle: text,
  models: z.tuple([section, section]),
  storageTitle: text,
  storageLead: text,
  storage: z.tuple([section, section]),
  storageNote: text,
  standalone: section,
  standaloneLink: text,
  guidesTitle: text,
  guidesLead: text,
  guides: z.strictObject({ files: section, boundary: section, branching: section, shell: section }),
});
export type HomeMessages = z.infer<typeof homeMessagesSchema>;

export const filesMessagesSchema = basic.extend({
  methods: z.tuple([section, section]),
  diagramCaption: text,
  permissions: section,
  checklist: z.tuple([section, section, section]),
  stepsTitle: text,
  steps: paragraph,
  next: text,
});
export type FilesMessages = z.infer<typeof filesMessagesSchema>;

export const boundaryMessagesSchema = basic.extend({
  diagramTitle: text,

  motionNote: text,
  sections: z.tuple([section, section, section]),
  next: text,
});
export type BoundaryMessages = z.infer<typeof boundaryMessagesSchema>;

export const branchingCopySchema = z.strictObject({
  label: text,
  prompt: text,
  replies: z.tuple([text, text]),
  choices: z.tuple([text, text]),
  reset: text,
  note: text,
});
export type BranchingCopy = z.infer<typeof branchingCopySchema>;
export const branchingPayloadSchema = z.strictObject({ copy: branchingCopySchema });
export const branchingMessagesSchema = basic.extend({
  stepsTitle: text,
  steps: paragraph,
  demoTitle: text,
  demo: branchingCopySchema,
  detail: section,
  next: text,
});
export type BranchingMessages = z.infer<typeof branchingMessagesSchema>;

export const shellMessagesSchema = basic.extend({
  sections: z.tuple([section, section, section]),
  diagramCaption: text,
  stepsTitle: text,
  steps: paragraph,
  exampleTitle: text,
  exampleNote: text,
  next: text,
});
export type ShellMessages = z.infer<typeof shellMessagesSchema>;

export const standaloneMessagesSchema = basic.extend({
  diagramCaption: text,
  download: text,
  stepsTitle: text,
  steps: z.tuple([section, section, section]),
  modesTitle: text,
  modes: z.tuple([section, section]),
  details: z.tuple([section, section, section]),
  next: text,
});
export type StandaloneMessages = z.infer<typeof standaloneMessagesSchema>;

export const pageMessageSchemas = {
  index: homeMessagesSchema,
  'files/privacy': filesMessagesSchema,
  'run/standalone': standaloneMessagesSchema,
  'work/boundary': boundaryMessagesSchema,
  'chat/branching': branchingMessagesSchema,
  'work/browser-shell': shellMessagesSchema,
};


export const entryMessagesSchema = z.object({
  choose: text,
  missingTitle: text,
  missingBody: text,
}).strict();
export type EntryMessages = z.infer<typeof entryMessagesSchema>;
