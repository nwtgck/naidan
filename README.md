# LM Web UI

> [!NOTE]
> Most of this project was created by Gemini 3 with significantly less human review than my usual projects.

A privacy-focused web interface for LLMs (OpenAI-compatible APIs and Ollama), featuring advanced tree-based conversation branching and secure, browser-based storage.

## Key Features

- **Privacy-First**: Your data never leaves your browser. All conversations are stored locally using OPFS or LocalStorage, ensuring complete privacy with no cloud tracking or external dependencies.
- **Infinite Branching**: Effortlessly fork or edit any message to create complex, tree-structured conversations without losing context.
- **Intuitive Organization**: Seamlessly manage your chats using a drag-and-drop sidebar with support for custom groups and reordering.
- **Rich Rendering**: First-class support for Markdown, LaTeX mathematical equations (KaTeX), and Mermaid diagrams.

## Development

```bash
npm ci
npm run dev
```