# Block Markdown Renderer Development Rules

## Test Writing Style

### Multi-line Strings in Tests
When writing multi-line Markdown content in tests, always use the backslash escape (`\`) immediately after the opening backtick (`` ` ``). This ensures the first line starts without an unwanted newline and maintains clean indentation.

**Style Mandate (CRITICAL):**
- NO leading whitespace on content lines.
- NO indentation for the Markdown content itself.
- ALWAYS use `\` (backslash) after the opening backtick.
- **MUST RULE**: You MUST use the `read_file` tool to verify if there is a backslash (`\`) immediately after the opening backtick (`` ` ``) in any code generation or modification.

### Triple Backticks in Template Literals
When you need to include triple backticks (`` ``` ``) inside a JavaScript/TypeScript template literal (e.g., in tests), you MUST use interpolation to prevent parsing issues or premature string termination.

**Style Mandate (CRITICAL):**
- ALWAYS use `${'```'}` instead of literal `` ``` ``.

### DOM Assertion Principle: Implicit behavior is evil
When asserting the rendered DOM, always use the `normalizeDom` utility. You MUST explicitly define all normalization behaviors (like trimming or preserving specific attributes) in the function call to ensure transparency.

**Style Mandate (CRITICAL):**
- ALWAYS use `normalizeDom` with explicit configuration to ensure transparency.
- **Structural Integrity**: Focus on verifying the DOM structure and nesting relationships. It is crucial to ensure that elements are correctly nested (e.g., a `li` inside an `ol`, or a `span` inside a `p`).
- **Precision**: While `.toContain()` is allowed for brevity, the assertion should be specific enough to verify the intended hierarchy, not just the presence of a tag.

#### ✅ GOOD (Full Test Example)
```typescript
it('renders a code block', () => {
  const content = `\
${'```'}js
const x = 1;
${'```'}
`;
  const wrapper = mount(BlockMarkdownRenderer, { props: { content } });
  
  // Explicitly define what to preserve/normalize to get a stable string
  const dom = normalizeDom({
    element: wrapper.element,
    preserveAttributes: ['class'],
    trimWhitespaceNodes: true
  });
  
  // Verify the exact structure of the code block components
  expect(dom).toContain('<pre><code class="language-js"><span>const x = 1;</span></code></pre>');
});
```
