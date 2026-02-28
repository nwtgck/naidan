# Block Markdown Renderer

This directory contains the implementation of a block-based Markdown renderer designed for high-performance streaming updates.

## Architecture

Instead of rendering the entire Markdown string to HTML and replacing the DOM on every update (which destroys selection and scroll state), this renderer:
1.  **Lexes** the Markdown into tokens (blocks) using `marked.lexer`.
2.  **Renders** each block as a separate Vue component (`BlockMarkdownItem`).
3.  **Diffs** efficiently: Vue's `v-for` ensures that stable blocks (e.g., previous paragraphs) reuse their existing DOM nodes. Only the last, active block is updated.

## Components

- **`BlockMarkdownRenderer.vue`**: The entry point. Takes `content` string prop.
- **`BlockMarkdownItem.vue`**: Recursive component that handles block types (Paragraph, Heading, List, etc.).
- **`MarkdownInline.vue`**: Renders inline formatting (bold, links) using `marked.parseInline`.
- **`CodeBlockWrapper.vue`**: Dispatches code blocks to specialized renderers.
- **`StandardCodeBlock.vue`**: Handles syntax highlighting and **preserves scroll position** during updates.
- **`MermaidBlock.vue`**: Isolated Mermaid rendering (only re-renders when its specific code changes).
- **`GeneratedImageBlock.vue`**: Native Vue implementation of image display (replaces the old hydration logic).

## Key Benefits

- **Selection Stability**: Users can select text in previous paragraphs while the message is still generating.
- **Scroll Stability**: Code blocks don't jump to the top when content is appended.
- **Performance**: Mermaid diagrams are not re-parsed/re-rendered on every keystroke.
