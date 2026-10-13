export const strings = {
  "title": "Let AI work with files using a browser shell",
  "description": "Ask AI to search and work with selected files through shell tools running inside the browser.",
  "intro": [
    "Ask AI to find unfinished tasks in project notes, compare files or process a table. With Shell enabled, the AI can use familiar commands through a tool call, read the result and continue its answer.",
    "The commands run in the browser’s shell, with access to the workspace and folders made available to the Chat. You choose the folder mounts and write access in advance."
  ],
  "diagramCaption": "A sample task in a writable local project: the AI checks Git, searches with grep, reads with sed, creates task-summary.md with cat <<EOF and checks the saved file and Git state. Each command is a separate shell_execute call. Completed call headers stay in the conversation; the current call shows its script and result. The scene replays together, and the full transcript remains available to read. No model, command or file operation runs in this demonstration.",
  "demo": {
    "title": "Project tasks",
    "address": "Naidan / Project tasks",
    "you": "You",
    "assistant": "Assistant",
    "prompt": "Check Git and the TODOs in the project notes, then save a task summary in task-summary.md.",
    "generating": "Generating tool call…",
    "sequenceSummaries": {
      "git": "1 tool execution • Used shell_execute",
      "grep": "2 tool executions • Used shell_execute",
      "sed": "3 tool executions • Used shell_execute",
      "write": "4 tool executions • Used shell_execute",
      "review": "5 tool executions • Used shell_execute",
    },
    "showDetails": "Show",
    "lessDetails": "Less",
    "hideToolExecutions": "Hide Tool Executions",
    "executing": "Executing...",
    "rawJson": "Raw JSON",
    "disableWrap": "Disable wrap",
    "noteLines": ["Confirm the venue", "Send invitations"],
    "notesTitle": "Project notes",
    "reviewNote": "Next review: Friday.",
    "summaryTitle": "Task summary",
    "stepTitles": {
      "git": "Check the initial Git state",
      "grep": "Find TODOs and their line numbers",
      "sed": "Read the surrounding notes",
      "write": "Create the summary with a here-document",
      "review": "Read the saved file and check Git again",
    },
    "transcriptTitle": "Commands and results",
    "transcriptCount": "5 calls",
    "transcriptCommand": "Command",
    "transcriptResult": "Result",
    "transcriptIntro": "This sample starts with a clean local Git repository mounted at /home/user/project with write access. notes.md is tracked, and task-summary.md does not exist yet.",
    "responseLead": "Created task-summary.md with these two tasks. Git reports the summary as a new, untracked file.",
    "responseItems": ["Confirm the venue.", "Send invitations."],
  },
  "sections": [
    {
      "title": "Familiar commands, a browser-backed filesystem",
      "body": "The shell is called Wesh internally. Commands such as ls, cat, grep, sed, jq and Git operate on its mounted filesystems. An OS executable is not automatically a Wesh command: each supported command is implemented for this environment.",
    },
    {
      "title": "A workspace scoped to the conversation",
      "body": "Shell-enabled Chats can have a writable workspace. Global, Chat Group and Chat settings resolve which folders are mounted; a more specific mount at the same path takes precedence. Read-only access is enough for searches. Creating a file, as in the example, requires write access. Shell calls use these effective settings, without a separate approval prompt for every command.",
    },
    {
      "title": "Let the AI read the conversation as files",
      "body": "Naidan projects Chat information into /sys/fs/naidan as read-only Markdown and JSON files. Choose the current Chat, its Chat Group or the main Chat collection as the visible scope. These familiar file formats let the AI use ordinary shell commands to find information without exposing all history by default.",
    }
  ],
  "commandsTitle": "Commands available inside the browser",
  "commandsIntro": "These are representative commands implemented in Wesh. They work on files visible to the Chat; changing files requires write access to their mounted folder.",
  "commands": [
    {
      "title": "Find and organize files",
      "names": ["ls", "tree", "find", "cat", "cp", "mv", "mkdir"],
      "body": "Inspect a folder, find a file or read its contents. Copy or rename files and create folders in writable locations.",
    },
    {
      "title": "Search and process text",
      "names": ["grep", "rg", "sed", "awk", "sort", "uniq", "wc"],
      "body": "Find matching lines, replace text, extract fields, sort lines, remove adjacent duplicates or count the results. Combine commands with pipes for a longer task.",
    },
    {
      "title": "Extract structured data",
      "names": ["jq", "cut"],
      "body": "Query and transform JSON with jq, or select columns from delimiter-separated text with cut.",
    },
    {
      "title": "Pack and unpack files",
      "names": ["zip", "unzip", "gzip", "gunzip"],
      "body": "Create or extract ZIP archives and compress or decompress gzip files inside the browser.",
    },
    {
      "title": "Compare and check files",
      "names": ["diff", "patch", "sha256sum"],
      "body": "Compare file versions, apply a text patch or compute and check SHA-256 checksums.",
    },
    {
      "title": "Review and save changes with Git",
      "names": ["git status", "git diff", "git log", "git add", "git commit"],
      "body": "Inspect a mounted repository and record changes as commits. Repository transfers use local paths visible to Wesh; Internet repository connections are disabled.",
    },
  ],
  "commandsHelp": "See the full command list and command-specific options:",
  "stepsTitle": "Give a Chat a working shell",
  "steps": [
    "Open the Chat’s tool settings and enable Shell. Check whether a setting is inherited from the Chat Group or global settings, and use a model that supports tool calls.",
    "Inspect the effective folder mounts, write access and which Chats the shell can see. For a folder on your PC, grant the browser access when selecting it.",
    "Ask the AI to list files or find information in a selected folder. It generates a shell_execute call, receives the command’s result and continues the conversation.",
    "Open the process summary to inspect the tool call. Click a result preview to expand it, or open Raw JSON to inspect the arguments. The separate Shell terminal is also available when you want to run commands yourself."
  ],
  "exampleTitle": "Inspect the current Chat",
  "exampleNote": "These commands read the current Chat when that scope is enabled. The metadata file describes the Chat; content-md and branches expose its messages and paths. This example does not modify data.",
  "next": "Set file and folder access",
};
