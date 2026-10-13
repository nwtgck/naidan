// English copy is the local source of truth. Japanese copy uses these types
// with satisfies so the two languages keep the same authored shape.
export type CommonMessages = typeof import('../strings/common/en').strings;
export type EntryMessages = typeof import('../strings/entry/en').strings;
export type HomeMessages = typeof import('../strings/index/en').strings;
export type FilesMessages = typeof import('../strings/files/privacy/en').strings;
export type BoundaryMessages = typeof import('../strings/work/boundary/en').strings;
export type BranchingMessages = typeof import('../strings/chat/branching/en').strings;
export type ShellMessages = typeof import('../strings/work/browser-shell/en').strings;
export type StandaloneMessages = typeof import('../strings/run/standalone/en').strings;
export type InBrowserModelsMessages = typeof import('../strings/models/in-browser/en').strings;
export type LocalEnginesMessages = typeof import('../strings/models/local-engines/en').strings;
export type OllamaGuideMessages = typeof import('../strings/models/ollama/en').strings;

export type ReplicaChromeCopy = CommonMessages['chrome'];
export type HomeDemoCopy = HomeMessages['demo'];
export type BoundaryDiagramCopy = HomeMessages['boundary'];
export type FolderAccessCopy = FilesMessages['demo'];
export type BranchingCopy = BranchingMessages['demo'];
export type ShellDemoCopy = ShellMessages['demo'];
export type StandaloneDemoCopy = StandaloneMessages['demo'];
