import type { Settings } from '../../models/types';

// --- Export Options ---
export interface ExportOptions {
  fileNameSegment?: string;
}

// --- Import Strategies ---
export type ImportFieldStrategy = 'replace' | 'none';
export type ImportListStrategy = 'replace' | 'append' | 'none';
export type ImportDataMode = 'replace' | 'append';

export interface ImportConfig {
  settings: {
    endpoint: ImportFieldStrategy;       // URL & Type
    model: ImportFieldStrategy;          // Default Model
    titleModel: ImportFieldStrategy;     // Title Generation Model
    systemPrompt: ImportFieldStrategy;   // Global System Prompt
    lmParameters: ImportFieldStrategy;   // Temperature, etc.
    providerProfiles: ImportListStrategy;
  };
  data: {
    mode: ImportDataMode;
    chatTitlePrefix?: string;
    chatGroupNamePrefix?: string;
  };
}

// --- Import Preview Structure (For UI Display) ---
export interface PreviewChat {
  id: string;
  title: string | null;
  updatedAt: number;
  messageCount: number;
  _order: number;
}

export interface PreviewChatGroup {
  id: string;
  name: string;
  updatedAt: number;
  isCollapsed: boolean;
  items: PreviewChat[];
  _order: number;
}

export type ImportPreviewItem = 
  | { type: 'chat', data: PreviewChat }
  | { type: 'chat_group', data: PreviewChatGroup };

export interface ImportPreview {
  appVersion: string;
  exportedAt: number;
  stats: {
    chatsCount: number;
    chatGroupsCount: number;
    attachmentsCount: number;
    hasSettings: boolean;
    providerProfilesCount: number;
  };
  items: ImportPreviewItem[];
  previewSettings?: Settings;
}
