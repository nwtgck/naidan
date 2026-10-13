import type { ShellMessages } from '../../../site/messages';

export const strings = {
  "title": "Use a shell in your browser",
  "description": "Work with files and conversation context through familiar commands inside the browser.",
  "intro": [
    "A shell is a practical way for AI to inspect a project and make changes. It does not have to be your device’s native shell. Naidan provides a shell environment inside the browser."
  ],
  "sections": [
    {
      "title": "Familiar commands, browser-contained execution",
      "body": "The shell, internally called Wesh, provides commands for file operations, text processing and local Git workflows. Its filesystem is defined by the mounts available to the Chat.",
    },
    {
      "title": "Choose the working data",
      "body": "Use a separate workspace or a linked folder and select read-only or writable access. Global, Chat Group and Chat settings determine the effective mounts.",
    },
    {
      "title": "Let AI inspect conversation context",
      "body": "Naidan projects selected Chat data into a read-only virtual filesystem at /sys/fs/naidan. Choose whether the shell sees the current Chat, its Chat Group, or the main Chat collection.",
    }
  ],
  "exampleTitle": "Inspect the current Chat",
  "exampleNote": "The paths shown here are examples for a shell session with the current Chat exposed. They are not paths on the host operating system.",
  "next": "Choose file and folder access",
} satisfies ShellMessages;
