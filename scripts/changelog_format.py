"""Shared, offline Markdown contract for release preparation and publication.

Keep scanning/rendering pure: no Git, file access, credentials, or network.
"""
from __future__ import annotations

from datetime import date
import re


VERSION_CORE = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
RELEASE_HEADING_PATTERN = re.compile(rf'## \[({VERSION_CORE})\] - ([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}})')
REFERENCE_PATTERN = re.compile(
    r" {0,3}\[([^\]]+)\]:[ \t]+(?:<[^<>\s]+>|\S+?)"
    r"(?:[ \t]+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?[ \t]*"
)
# Conservative UTF-8 byte ceiling; never truncate user-written Markdown.
MAX_BODY_BYTES = 125_000


def markdown_lines(*, content: str) -> list[tuple[int, str]]:
    """Inspect ordinary Markdown without treating comments/code examples as structure.

    Release headings deliberately use an unindented, canonical ATX form. This is
    not a general Markdown renderer: it only masks comments and code while keeping
    original line numbers for a lossless edit of the surrounding document.
    """
    result: list[tuple[int, str]] = []
    fence: str | None = None
    in_comment = False
    for index, line in enumerate(content.splitlines(keepends=True)):
        if fence is not None:
            if re.fullmatch(r' {0,3}' + re.escape(fence[0]) + '{' + str(len(fence)) + r',}[ \t]*[\r\n]*', line):
                fence = None
            continue
        # Read fence info literally; an HTML example may name <!-- in its info.
        if not in_comment:
            # Link destinations/titles are literal here; HTML comment markers
            # inside a reference title must not consume following sections.
            if re.match(r' {0,3}\[[^\]]+\]:', line):
                result.append((index, line.rstrip('\r\n')))
                continue
            opening = re.match(r' {0,3}(`{3,}|~{3,})(.*)', line)
            if opening is not None:
                if opening.group(1)[0] != '`' or '`' not in opening.group(2):
                    fence = opening.group(1)
                    continue
            # Indented code is literal, not an opening HTML comment.
            if line.startswith(('    ', '\t')):
                result.append((index, line.rstrip('\r\n')))
                continue
        visible = ''
        offset = 0
        while offset < len(line):
            if in_comment:
                end = line.find('-->', offset)
                if end == -1:
                    break
                offset = end + 3
                in_comment = False
                continue
            token = re.search(r'`+|<!--', line[offset:])
            if token is None:
                visible += line[offset:]
                break
            start = offset + token.start()
            visible += line[offset:start]
            marker = token.group()
            if marker == '<!--':
                in_comment = True
                offset = start + len(marker)
                continue
            # Only a matching run ends an inline code span. An unmatched run is
            # ordinary text, so it must not hide a real comment later in the line.
            closing = re.search(r'(?<!`)' + re.escape(marker) + r'(?!`)', line[start + len(marker):])
            if closing is None:
                visible += marker
                offset = start + len(marker)
            else:
                end = start + len(marker) + closing.end()
                visible += line[start:end]
                offset = end
        result.append((index, visible.rstrip('\r\n')))
    if in_comment or fence is not None:
        raise SystemExit('CHANGELOG.md contains an unterminated HTML comment or fenced code block.')
    return result


def reference_key(*, label: str) -> str:
    return ' '.join(label.split()).casefold()


def render_notes(*, content: str) -> dict[str, str]:
    """Render Naidan's documented Markdown subset, not arbitrary Markdown."""
    content = content.replace('\r\n', '\n')
    lines = content.splitlines(keepends=True)
    try:
        visible = markdown_lines(content=content)
    except SystemExit as exc:
        raise ValueError(str(exc)) from exc
    headings = [(i, text) for i, text in visible if re.match(r' {0,3}##(?:[ \t]|$)', text)]
    if not headings or headings[0][1].rstrip() != '## [Unreleased]':
        raise ValueError('CHANGELOG.md must begin its sections with ## [Unreleased].')
    versions: list[tuple[int, str]] = []
    previous = None
    for index, text in headings[1:]:
        match = RELEASE_HEADING_PATTERN.fullmatch(text.rstrip())
        if match is None:
            raise ValueError(f'Invalid changelog heading on line {index + 1}: {text}')
        version, released = match.groups()
        date.fromisoformat(released)
        numeric = tuple(int(part) for part in version.split('.'))
        if previous is not None and numeric >= previous:
            raise ValueError('Changelog releases must be unique and ordered newest first.')
        previous = numeric
        versions.append((index, version))

    references: dict[str, str] = {}
    footer = len(lines)
    for index, text in visible:
        if not re.match(r' {0,3}\[[^\]]+\]:', text):
            continue
        original = lines[index].rstrip('\n')
        match = REFERENCE_PATTERN.fullmatch(original)
        if match is None:
            raise ValueError('Changelog references must use single-line Markdown definitions.')
        key = reference_key(label=match.group(1))
        if key in references:
            raise ValueError(f'Duplicate changelog reference: {key}')
        if index <= headings[-1][0]:
            raise ValueError('Place reference definitions after all release sections.')
        references[key] = original
        footer = min(footer, index)
    # Avoid silently throwing away prose or fenced examples after the link block.
    visible_by_index = dict(visible)
    for index in range(footer, len(lines)):
        text = visible_by_index.get(index)
        if text is None or (text.strip() and REFERENCE_PATTERN.fullmatch(lines[index].rstrip('\n')) is None):
            raise ValueError('Only reference definitions and comments may follow the link footer.')

    notes = {}
    for position, (start, version) in enumerate(versions):
        end = versions[position + 1][0] if position + 1 < len(versions) else footer
        body_lines = lines[start + 1:end]
        # Trim separating blank lines only, retaining Markdown hard line breaks.
        while body_lines and not body_lines[0].strip():
            body_lines.pop(0)
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()
        body = ''.join(body_lines).rstrip('\n')
        used = set()
        for _, text in markdown_lines(content=body):
            if text.startswith(('    ', '\t')):
                continue
            text = re.sub(r'(`+).*?\1', '', text)
            # Conservatively retain defined bracket labels, including full,
            # collapsed, shortcut, and image references; do not rewrite prose.
            for label in re.findall(r'(?<!\\)\[([^\[\]]+)\]', text):
                key = reference_key(label=label)
                if key in references:
                    used.add(key)
        if version in references:
            body += ('\n\n' if body else '') + f'[Full Changelog][{version}]'
            used.add(version)
        if used:
            body += '\n\n' + '\n'.join(references[key] for key in sorted(used))
        body += '\n' if body else ''
        if len(body.encode('utf-8')) > MAX_BODY_BYTES:
            raise ValueError(f'Release v{version} exceeds the release-note size limit.')
        notes[f'v{version}'] = body
    return notes
