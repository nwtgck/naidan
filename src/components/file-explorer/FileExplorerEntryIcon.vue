<script setup lang="ts">
import {
  FolderIcon, FileTextIcon, ImageIcon, VideoIcon, MusicIcon, FileIcon,
  FileCodeIcon, FileJsonIcon, FileTypeIcon,
} from 'lucide-vue-next';
import type { EntryKind, MimeCategory } from './types';

const props = defineProps<{
  kind: EntryKind;
  extension: string;
  mimeCategory: MimeCategory;
  size?: 'sm' | 'md' | 'lg';
}>();

const sizeClass = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-10 h-10',
};

function getIcon() {
  switch (props.kind) {
  case 'directory': return FolderIcon;
  case 'file': break;
  default: {
    const _ex: never = props.kind;
    void _ex;
  }
  }

  switch (props.mimeCategory) {
  case 'image': return ImageIcon;
  case 'video': return VideoIcon;
  case 'audio': return MusicIcon;
  case 'text': {
    switch (props.extension) {
    case '.json':
    case '.jsonl':
      return FileJsonIcon;
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.vue':
    case '.py':
    case '.rs':
    case '.go':
    case '.rb':
    case '.php':
    case '.java':
    case '.kt':
    case '.swift':
    case '.c':
    case '.cpp':
    case '.cs':
      return FileCodeIcon;
    case '.md':
    case '.markdown':
      return FileTypeIcon;
    default:
      return FileTextIcon;
    }
  }
  case 'binary':
    return FileIcon;
  default: {
    const _exhaustiveCheck: never = props.mimeCategory;
    void _exhaustiveCheck;
    return FileIcon;
  }
  }

}

function getColorClass() {
  switch (props.kind) {
  case 'directory': return 'text-amber-500';
  case 'file': return 'text-blue-500';
  default: {
    const _ex: never = props.kind;
    void _ex;
    return 'text-gray-400';
  }
  }
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <component
    :is="getIcon()"
    :class="[sizeClass[size ?? 'sm'], getColorClass()]"
  />
</template>
