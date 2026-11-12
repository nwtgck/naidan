#!/usr/bin/env python3

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, NamedTuple

from changelog_format import RELEASE_HEADING_PATTERN, VERSION_CORE, markdown_lines, render_notes


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent
PACKAGE_JSON_PATH = REPO_ROOT / 'package.json'
PACKAGE_LOCK_JSON_PATH = REPO_ROOT / 'package-lock.json'
CHANGELOG_PATH = REPO_ROOT / 'CHANGELOG.md'
FRAGMENTS_PATH = REPO_ROOT / 'changelog-unreleased'
VERSION_PATTERN = re.compile(r'^(?P<major>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)\.(?P<patch>0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$')
CHANGE_CATEGORY_ORDER = ('Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security')
CHANGE_CATEGORIES = set(CHANGE_CATEGORY_ORDER)
FRAGMENT_NAME_PATTERN = re.compile(
    r'changes-(?P<timestamp>[0-9]{8}T[0-9]{6}\.[0-9]{3}Z)-[a-z0-9]+(?:-[a-z0-9]+)*\.md'
)
INSTRUCTIONS_START = '<!-- changelog-unreleased:instructions'


class ChangelogFragment(NamedTuple):
    path: Path
    original: str
    category: str
    bullet: str


def main() -> int:
    args = parse_args()
    ensure_git_branch(expected_branch='develop')

    package_json = read_json_file(path=PACKAGE_JSON_PATH)
    package_lock_json = read_json_file(path=PACKAGE_LOCK_JSON_PATH)
    current_version = read_current_version(package_json=package_json)
    next_version = bump_version(current_version=current_version, bump_kind=args.bump_kind)
    release_branch_name = create_release_branch_name(bump_kind=args.bump_kind, next_version=next_version)

    if release_branch_name is not None:
        ensure_branch_does_not_exist(branch_name=release_branch_name)
        ensure_tag_does_not_exist(tag=f'v{next_version}')

    # Finish all content validation before creating a branch or writing any file.
    update_versions(package_json=package_json, package_lock_json=package_lock_json, next_version=next_version)
    updates = [
        (PACKAGE_JSON_PATH, serialize_json(content=package_json)),
        (PACKAGE_LOCK_JSON_PATH, serialize_json(content=package_lock_json)),
    ]
    fragments: tuple[ChangelogFragment, ...] = ()
    release_body = ''
    if release_branch_name is not None:
        fragments = load_changelog_fragments(directory=FRAGMENTS_PATH)
        release_date = args.release_date if args.release_date is not None else datetime.now(timezone.utc).date()
        changelog = prepare_changelog(
            content=read_text_file(path=CHANGELOG_PATH),
            next_version=next_version,
            release_date=release_date,
            allow_empty=args.allow_empty_changelog,
            fragments=fragments,
        )
        # Use exactly the publication renderer, including its UTF-8 byte ceiling
        # and reference-footer rules, before any branch or file mutation.
        try:
            release_body = render_notes(content=changelog)[f'v{next_version}']
        except ValueError as exc:
            raise SystemExit(f'Cannot publish the prepared changelog: {exc}') from exc
        updates.append((CHANGELOG_PATH, changelog))
        print(f'Changelog release: {next_version} - {release_date.isoformat()} (UTC)')

    print(f'Current version: {current_version}')
    print(f'Next version: {next_version}')
    if release_branch_name is not None:
        print(f'Creating branch: {release_branch_name}')
    else:
        print('No release branch will be created for dev bump; CHANGELOG.md is unchanged.')
    print('Files to update:')
    for path, _ in updates:
        print(f'- {path.relative_to(REPO_ROOT)}')
    if release_branch_name is not None:
        print(f'Changelog fragments to consume: {len(fragments)}')
        for fragment in fragments:
            print(f'- {fragment.path.relative_to(REPO_ROOT)} (delete after integration)')
    print(f'Commit message: bump: {next_version}')

    if args.dry_run:
        if release_branch_name is not None:
            print('Planned release notes:\n' + release_body)
        print('Dry run only. No branch, file, or commit changes were made.')
        return 0

    ensure_clean_worktree()
    if release_branch_name is not None:
        ensure_fragments_tracked(fragments=fragments)
        ensure_fragments_unchanged(directory=FRAGMENTS_PATH, fragments=fragments)
    try:
        if release_branch_name is not None:
            run_git_command(args=['checkout', '-b', release_branch_name])
            ensure_fragments_unchanged(directory=FRAGMENTS_PATH, fragments=fragments)
        for path, content in updates:
            write_text_file(path=path, content=content)
        if release_branch_name is not None:
            ensure_fragments_unchanged(directory=FRAGMENTS_PATH, fragments=fragments)
        for fragment in fragments:
            fragment.path.unlink()
        paths = [path for path, _ in updates] + [fragment.path for fragment in fragments]
        stage_release_paths(paths=paths)
        run_git_command(args=['commit', '-m', f'bump: {next_version}'])
    except (OSError, SystemExit):
        # Do not reset the index or discard the operator's recoverable work.
        print('Release preparation failed. Inspect the working tree, index, and current branch before retrying.', file=sys.stderr)
        raise

    if release_branch_name is not None:
        print(f'Release branch ready: {release_branch_name}')
    else:
        print(f'Development version committed on develop: {next_version}')
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Start a release branch from develop without git-flow.')
    parser.add_argument('bump_kind', choices=['major', 'minor', 'patch', 'dev'], help='Release bump kind or the next development bump.')
    parser.add_argument('--dry-run', action='store_true', help='Validate and print the plan without changing files or git state.')
    parser.add_argument('--date', dest='release_date', type=parse_release_date, help='Release date as a UTC calendar date in YYYY-MM-DD (default: today in UTC).')
    parser.add_argument('--allow-empty-changelog', action='store_true', help='Explicitly allow a release with no notable changes in Unreleased or changelog fragments.')
    args = parser.parse_args()
    if args.bump_kind == 'dev' and (args.release_date is not None or args.allow_empty_changelog):
        parser.error('--date and --allow-empty-changelog are only valid for major, minor, or patch releases.')
    return args


def parse_release_date(value: str) -> date:
    # argparse's type callback has a positional argument contract.
    if re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value) is not None:
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise argparse.ArgumentTypeError('The release date must be a valid YYYY-MM-DD date.')


def changelog_fragment_paths(*, directory: Path) -> tuple[Path, ...]:
    """Select only direct changes-*.md children; never follow linked directories."""
    try:
        mode = directory.lstat().st_mode
    except FileNotFoundError:
        return ()
    except OSError as exc:
        raise SystemExit(f'Cannot inspect changelog directory {directory}: {exc}') from exc
    if not stat.S_ISDIR(mode):
        raise SystemExit(f'Changelog directory must be a real directory, not a symlink: {directory}')
    try:
        return tuple(sorted(
            (path for path in directory.iterdir() if path.name.startswith('changes-') and path.name.endswith('.md')),
            key=lambda path: path.name,
        ))
    except OSError as exc:
        raise SystemExit(f'Cannot list changelog directory {directory}: {exc}') from exc


def parse_changelog_fragment(*, path: Path, content: str) -> ChangelogFragment:
    """Parse one heading and one paragraph-style item, not arbitrary Markdown."""
    match = FRAGMENT_NAME_PATTERN.fullmatch(path.name)
    if match is None:
        raise SystemExit(f'Invalid changelog fragment filename: {path}; expected changes-YYYYMMDDTHHMMSS.sssZ-<topic>.md')
    try:
        datetime.strptime(match.group('timestamp'), '%Y%m%dT%H%M%S.%fZ')
    except ValueError as exc:
        raise SystemExit(f'Invalid UTC creation time in changelog fragment: {path}') from exc
    normalized = content.replace('\r\n', '\n')
    # splitlines() recognizes more than LF/CRLF. Reject those separators rather
    # than disagreeing with Markdown about where the item's boundaries are.
    if re.search(r'[\x00-\x08\x0b-\x1f\x7f\x85\u2028\u2029\ufeff]', normalized):
        raise SystemExit(f'Invalid control character or BOM in changelog fragment: {path}')
    lines = normalized.split('\n')
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines or lines[0].rstrip(' \t') not in {f'### {name}' for name in CHANGE_CATEGORIES}:
        raise SystemExit(f'Invalid category heading in changelog fragment: {path}')
    category = lines.pop(0).rstrip(' \t')[4:]
    if not lines or lines[0].strip():
        raise SystemExit(f'Expected a blank line after the fragment heading: {path}')
    while lines and not lines[0].strip():
        lines.pop(0)
    if (not lines or not lines[0].startswith('- ') or not lines[0][2:].strip()
            or lines[0][2:3].isspace()):
        raise SystemExit(f'Expected one nonempty - bullet in changelog fragment: {path}')
    for index, line in enumerate(lines):
        if index and (not line.startswith('  ') or not line[2:].strip() or line[2:3].isspace()):
            raise SystemExit(f'Use one paragraph-style bullet with indented continuation lines: {path}')
        prose = (line[2:] if index == 0 else line).strip()
        # Restrict fragments to inline Markdown. Legacy Unreleased notes still
        # accept paragraphs, nested structure, comments and code examples.
        if (re.match(r'(?:#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|[0-9]+[.)](?:[ \t]|$)|>|~{3,}|\[[^\]]+\]:)', prose)
                or re.fullmatch(r'[-=*_]{3,}|\[[ xX]\]', prose)):
            raise SystemExit(f'Only inline Markdown and wrapped prose are allowed in a fragment bullet: {path}')
        ticks = re.match(r'(`{3,})(.*)', prose)
        if ticks is not None and re.search(r'(?<!`)' + re.escape(ticks.group(1)) + r'(?!`)', ticks.group(2)) is None:
            raise SystemExit(f'Fenced blocks are not allowed in a fragment bullet: {path}')
    bullet = '\n'.join(lines)
    try:
        visible = markdown_lines(content=bullet)
    except SystemExit as exc:
        raise SystemExit(f'Invalid Markdown in changelog fragment {path}: {exc}') from exc
    if visible != list(enumerate(lines)):
        raise SystemExit(f'Comments and fenced blocks are not allowed in changelog fragments: {path}')
    return ChangelogFragment(path=path, original=content, category=category, bullet=bullet)


def load_changelog_fragments(*, directory: Path) -> tuple[ChangelogFragment, ...]:
    return tuple(parse_changelog_fragment(path=path, content=read_text_file(path=path))
                 for path in changelog_fragment_paths(directory=directory))


def split_unreleased_instructions(*, content: str) -> tuple[str, str]:
    """Keep the explicitly marked leading comment, not arbitrary HTML comments."""
    lines = content.splitlines(keepends=True)
    visible = dict(markdown_lines(content=content))
    markers = [i for i, line in enumerate(lines)
               if re.match(r' {0,3}' + re.escape(INSTRUCTIONS_START) + r'(?:[ \t\r\n]|-->|$)', line)
               and i in visible and visible[i] != line.rstrip('\r\n')]
    if not markers:
        return '', content
    first = next((i for i, line in enumerate(lines) if line.strip()), len(lines))
    if len(markers) != 1 or markers[0] != first:
        raise SystemExit('The changelog-unreleased instructions comment must occur once, at the start of Unreleased.')
    if lines[first].strip() != INSTRUCTIONS_START:
        raise SystemExit('Put the changelog-unreleased instructions opening marker on its own line.')
    end = first + 1
    while end < len(lines) and '-->' not in lines[end]:
        if '<!--' in lines[end]:
            raise SystemExit('Nested comments are not allowed in changelog-unreleased instructions.')
        end += 1
    if end == len(lines) or lines[end].strip() != '-->':
        raise SystemExit('Close the changelog-unreleased instructions with --> on its own line.')
    return ''.join(lines[first:end + 1]), ''.join(lines[:first] + lines[end + 1:])


def merge_changelog_fragments(*, content: str, fragments: tuple[ChangelogFragment, ...], newline: str) -> str:
    if not fragments:
        return content
    grouped: dict[str, list[str]] = {}
    # Fixed-width UTC filenames sort chronologically; topic breaks timestamp ties.
    for fragment in sorted(fragments, key=lambda item: item.path.name):
        grouped.setdefault(fragment.category, []).append(fragment.bullet.replace('\n', newline))
    lines = content.splitlines(keepends=True)
    visible = markdown_lines(content=content)
    categories = [(index, text.strip()[4:].rstrip()) for index, text in visible
                  if re.fullmatch(r' {0,3}### (.+?)[ \t]*', text)]
    edits: list[tuple[int, str]] = []
    for position, (start, name) in enumerate(categories):
        bullets = grouped.pop(name, None)
        if bullets is None:
            continue
        end = categories[position + 1][0] if position + 1 < len(categories) else len(lines)
        # A subheading may be nested in a list item. Inserting immediately
        # before it could steal that item's remaining text. Prepend to the whole
        # category body instead, preserving the legacy block without splitting it.
        has_subsection = any(start < i < end and re.match(r' {0,3}#{4,6}(?:[ \t]|$)', text)
                             for i, text in visible)
        insertion = start + 1 if has_subsection else end
        edits.append((insertion, (newline + newline).join(bullets)))
    for index, body in reversed(edits):
        before = ''.join(lines[:index]).rstrip('\r\n')
        after = ''.join(lines[index:]).lstrip('\r\n')
        content = before + newline + newline + body + newline + newline + after
        lines = content.splitlines(keepends=True)
    for name in CHANGE_CATEGORY_ORDER:
        if name in grouped:
            content = (content.rstrip('\r\n') + newline + newline if content.strip('\r\n') else '') + (
                f'### {name}' + newline + newline + (newline + newline).join(grouped[name]) + newline
            )
    return content


def stage_release_paths(*, paths: list[Path]) -> None:
    # Feed exact paths on stdin instead of exceeding the platform's command-line
    # limit when a release collects many independently created entries.
    pathspec = ''.join(path.relative_to(REPO_ROOT).as_posix() + '\0' for path in paths)
    run_git_command(args=['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], input_text=pathspec)


def ensure_fragments_tracked(*, fragments: tuple[ChangelogFragment, ...]) -> None:
    names = {fragment.path.relative_to(REPO_ROOT).as_posix() for fragment in fragments}
    prefix = FRAGMENTS_PATH.relative_to(REPO_ROOT).as_posix() + '/'
    records = run_git_command(args=['ls-files', '-v', '-z', '--', prefix], capture_output=True)
    tracked = {}
    for record in records.split('\0'):
        if not record:
            continue
        name = record[2:]
        if not name.startswith(prefix):
            continue
        child = name[len(prefix):]
        if '/' not in child and child.startswith('changes-') and child.endswith('.md'):
            tracked[name] = record[0]
    if set(tracked) - names:
        raise SystemExit('Tracked changelog fragments are missing from the working tree; restore them before releasing (including sparse-checkout entries).')
    for name in sorted(names):
        # Ignored untracked files do not appear in git status. Never consume
        # those, nor tracked files whose modifications Git is configured to hide.
        if tracked.get(name) != 'H':
            raise SystemExit(f'Changelog fragment must be tracked without skip-worktree or assume-unchanged flags: {name}')


def ensure_fragments_unchanged(*, directory: Path, fragments: tuple[ChangelogFragment, ...]) -> None:
    paths = changelog_fragment_paths(directory=directory)
    if paths != tuple(fragment.path for fragment in fragments):
        raise SystemExit('Changelog fragment inventory changed during release preparation; review and retry.')
    for fragment in fragments:
        if read_text_file(path=fragment.path) != fragment.original:
            raise SystemExit(f'Changelog fragment changed during release preparation: {fragment.path}')


def prepare_changelog(*, content: str, next_version: str, release_date: date, allow_empty: bool,
                      fragments: tuple[ChangelogFragment, ...] = ()) -> str:
    if re.fullmatch(VERSION_CORE, next_version) is None:
        raise SystemExit(f'Unsupported release version: {next_version}')
    lines = content.splitlines(keepends=True)
    visible = markdown_lines(content=content)
    headings = [(index, text) for index, text in visible if re.match(r' {0,3}##(?:[ \t]|$)', text)]
    if not headings or headings[0][1].rstrip() != '## [Unreleased]':
        raise SystemExit('CHANGELOG.md must start its release sections with exactly one ## [Unreleased] heading.')
    releases: list[tuple[int, str, date]] = []
    previous_version: tuple[int, ...] | None = None
    for index, text in headings[1:]:
        match = RELEASE_HEADING_PATTERN.fullmatch(text.rstrip())
        if match is None:
            raise SystemExit(f'Invalid or duplicate changelog heading on line {index + 1}: {text}')
        version_text, date_text = match.groups()
        try:
            released_date = date.fromisoformat(date_text)
        except ValueError as exc:
            raise SystemExit(f'Invalid changelog date on line {index + 1}: {date_text}') from exc
        version = tuple(int(part) for part in version_text.split('.'))
        if previous_version is not None and version >= previous_version:
            raise SystemExit('Changelog releases must be unique and ordered newest first.')
        previous_version = version
        releases.append((index, version_text, released_date))
    if releases:
        latest_version = tuple(int(part) for part in releases[0][1].split('.'))
        if tuple(int(part) for part in next_version.split('.')) <= latest_version:
            raise SystemExit(f'{next_version} must be newer than the latest changelog release, {releases[0][1]}.')
        if release_date < releases[0][2]:
            raise SystemExit('The release date must not precede the latest changelog release date.')

    # Reference-style comparison links are ordinary Markdown. They are optional,
    # but if present their Unreleased base must agree with the latest heading.
    references: dict[str, tuple[int, str, int, int]] = {}
    reference_pattern = re.compile(
        r" {0,3}\[([^\]]+)\]:[ \t]+(?:<(?P<angle>[^<>\s]+)>|(?P<bare>\S+?))"
        r"(?:[ \t]+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?[ \t]*"
    )
    for index, text in visible:
        if not re.match(r' {0,3}\[', text):
            continue
        # Match against the original line: masking a comment must never shift
        # the offsets used to replace a destination inside a titled definition.
        match = reference_pattern.fullmatch(lines[index].rstrip('\r\n'))
        if match is None:
            # Do not silently leave a managed comparison link stale if a future
            # edit uses a multiline or otherwise unsupported definition.
            if re.match(r' {0,3}\[[ \t]*(?:Unreleased|v?' + VERSION_CORE + r')[ \t]*\]:', text, re.IGNORECASE):
                raise SystemExit('Changelog comparison links must use single-line Markdown definitions.')
            continue
        label = match.group(1)
        group = 'angle' if match.group('angle') is not None else 'bare'
        url = match.group(group)
        key = ' '.join(label.split()).casefold()
        if re.fullmatch('v' + VERSION_CORE, key):
            raise SystemExit(f'Changelog version link labels must omit the v prefix: [{label}]')
        if key in references:
            raise SystemExit(f'Duplicate changelog link definition: [{label}]')
        references[key] = (index, url, *match.span(group))

    if next_version in references:
        raise SystemExit(f'A changelog link for {next_version} already exists.')

    start = headings[0][0] + 1
    end = releases[0][0] if releases else len(lines)
    if not releases and references:
        end = min((index for index, *_ in references.values() if index >= start), default=end)
    categories: set[str] = set()
    has_notes = False
    for index, text in visible:
        if not start <= index < end:
            continue
        category = re.fullmatch(r' {0,3}### (.+?)[ \t]*', text)
        if category is not None:
            name = category.group(1)
            if name not in CHANGE_CATEGORIES or name in categories:
                raise SystemExit(f'Invalid or duplicate Unreleased category: {name}')
            categories.add(name)
        elif text.strip() and re.match(r' {0,3}\[[^\]]+\]:', text) is None:
            # Empty bullets, headings and horizontal rules are not reviewed notes.
            prose = re.sub(r'^\s*(?:[-+*]|[0-9]+[.)])(?:[ \t]+|$)(?:\[[ xX]\][ \t]*)?', '', text).strip()
            if re.fullmatch(r'([-*_])(?:[ \t]*\1){2,}', text.strip()):
                continue
            if prose and not re.match(r'^#{1,6}(?:[ \t]|$)', prose) and not re.fullmatch(r'([-*_])(?:[ \t]*\1){2,}', prose):
                has_notes = True
    if not has_notes and not fragments and not allow_empty:
        raise SystemExit('Unreleased has no release notes and no changelog fragments. Add reviewed English notes, or use --allow-empty-changelog for a release with no notable changes.')

    newline = '\r\n' if lines[headings[0][0]].endswith('\r\n') else '\n'
    if 'unreleased' in references:
        index, url, url_start, url_end = references['unreleased']
        if index < end or (releases and index < releases[-1][0]):
            raise SystemExit('Place changelog comparison link definitions after the release sections.')
        match = re.fullmatch(r'(.+/compare/)([^\s]+)\.\.\.([^\s]+)', url)
        if match is None or not releases or match.group(2) != f'v{releases[0][1]}':
            raise SystemExit('The Unreleased comparison link must start at the latest changelog tag.')
        prefix, previous_tag, target = match.groups()
        lines[index] = (
            lines[index][:url_start] + f'{prefix}v{next_version}...{target}' + lines[index][url_end:].rstrip('\r\n') + newline
            + f'[{next_version}]: {prefix}{previous_tag}...v{next_version}{newline}'
        )
    instructions, notes = split_unreleased_instructions(content=''.join(lines[start:end]))
    notes = merge_changelog_fragments(content=notes, fragments=fragments, newline=newline).strip('\r\n')
    prefix = ''.join(lines[:start]).rstrip('\r\n') + newline + newline
    if instructions:
        prefix += instructions.strip('\r\n') + newline + newline
    section = f'## [{next_version}] - {release_date.isoformat()}{newline}{newline}'
    if notes:
        section += notes + newline + newline
    return prefix + section + ''.join(lines[end:])


def ensure_git_branch(*, expected_branch: str) -> None:
    current_branch = run_git_command(args=['branch', '--show-current'], capture_output=True).strip()
    if current_branch != expected_branch:
        raise SystemExit(f'Expected current branch to be "{expected_branch}", but found "{current_branch}".')


def ensure_clean_worktree() -> None:
    status_output = run_git_command(args=['status', '--short', '--untracked-files=all'], capture_output=True).strip()
    if status_output != '':
        raise SystemExit('Working tree must be clean before starting a release.')


def ensure_branch_does_not_exist(*, branch_name: str) -> None:
    branch_output = run_git_command(args=['branch', '--list', branch_name], capture_output=True).strip()
    if branch_output != '':
        raise SystemExit(f'Branch already exists: {branch_name}')


def ensure_tag_does_not_exist(*, tag: str) -> None:
    if run_git_command(args=['tag', '--list', tag], capture_output=True).strip():
        raise SystemExit(f'Tag already exists: {tag}')


def read_text_file(*, path: Path) -> str:
    try:
        ensure_regular_file(path=path)
        # Preserve line endings so historical Markdown is not reserialized.
        with path.open(encoding='utf-8', newline='') as stream:
            return stream.read()
    except (OSError, UnicodeError) as exc:
        raise SystemExit(f'Cannot read required file {path}: {exc}') from exc


def ensure_regular_file(*, path: Path) -> None:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise SystemExit(f'Required release file must be a regular file, not a symlink or special file: {path}')


def write_text_file(*, path: Path, content: str) -> None:
    # Stage beside the destination so failed writes cannot truncate it. This is
    # atomic per file, not a transaction across the three release files and Git.
    ensure_regular_file(path=path)
    mode = stat.S_IMODE(path.stat().st_mode)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='',
                                         dir=path.parent, prefix=f'.{path.name}.', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_json_file(*, path: Path) -> dict[str, Any]:
    try:
        value = json.loads(read_text_file(path=path))
    except json.JSONDecodeError as exc:
        raise SystemExit(f'Invalid JSON in {path}: {exc}') from exc
    if not isinstance(value, dict):
        raise SystemExit(f'{path} must contain a JSON object.')
    return value


def serialize_json(*, content: dict[str, Any]) -> str:
    return json.dumps(content, ensure_ascii=True, indent=2) + '\n'


def read_current_version(*, package_json: dict[str, Any]) -> str:
    raw_version = package_json.get('version')
    if not isinstance(raw_version, str):
        raise SystemExit('package.json version must be a string.')
    if VERSION_PATTERN.fullmatch(raw_version) is None:
        raise SystemExit(f'Unsupported version format: {raw_version}')
    return raw_version


def bump_version(*, current_version: str, bump_kind: str) -> str:
    match = VERSION_PATTERN.fullmatch(current_version)
    if match is None:
        raise SystemExit(f'Unsupported version format: {current_version}')
    has_dev_suffix = current_version.endswith('-dev')
    major = int(match.group('major'))
    minor = int(match.group('minor'))
    patch = int(match.group('patch'))
    if bump_kind == 'dev':
        return f'{major}.{minor}.{patch + 1}-dev'
    if bump_kind == 'major':
        return f'{major + 1}.0.0'
    if bump_kind == 'minor':
        return f'{major}.{minor + 1}.0'
    if has_dev_suffix:
        return f'{major}.{minor}.{patch}'
    return f'{major}.{minor}.{patch + 1}'


def create_release_branch_name(*, bump_kind: str, next_version: str) -> str | None:
    if bump_kind == 'dev':
        return None
    return f'release/{next_version}'


def update_versions(*, package_json: dict[str, Any], package_lock_json: dict[str, Any], next_version: str) -> None:
    packages_section = package_lock_json.get('packages')
    if not isinstance(packages_section, dict):
        raise SystemExit('package-lock.json must contain a packages object.')
    root_package = packages_section.get('')
    if not isinstance(root_package, dict):
        raise SystemExit('package-lock.json must contain packages[""].')
    package_json['version'] = next_version
    package_lock_json['version'] = next_version
    root_package['version'] = next_version


def run_git_command(*, args: list[str], capture_output: bool = False, input_text: str | None = None) -> str:
    completed = subprocess.run(['git', *args], cwd=REPO_ROOT, check=False, capture_output=capture_output, text=True, input=input_text)
    if completed.returncode != 0:
        stderr = completed.stderr.strip() if completed.stderr is not None else ''
        raise SystemExit(stderr or f'Git command failed: git {" ".join(args)}')
    if capture_output:
        return completed.stdout
    return ''


if __name__ == '__main__':
    sys.exit(main())
