#!/usr/bin/env python3

from __future__ import annotations

import argparse
from datetime import date
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent
PACKAGE_JSON_PATH = REPO_ROOT / 'package.json'
PACKAGE_LOCK_JSON_PATH = REPO_ROOT / 'package-lock.json'
CHANGELOG_PATH = REPO_ROOT / 'CHANGELOG.md'
VERSION_CORE = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
VERSION_PATTERN = re.compile(r'^(?P<major>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)\.(?P<patch>0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$')
RELEASE_HEADING_PATTERN = re.compile(rf'## \[(v{VERSION_CORE})\] - ([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}})')
CHANGE_CATEGORIES = {'Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'}


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
    if release_branch_name is not None:
        release_date = args.release_date if args.release_date is not None else date.today()
        updates.append((CHANGELOG_PATH, prepare_changelog(
            content=read_text_file(path=CHANGELOG_PATH),
            next_version=next_version,
            release_date=release_date,
            allow_empty=args.allow_empty_changelog,
        )))
        print(f'Changelog release: v{next_version} - {release_date.isoformat()}')

    print(f'Current version: {current_version}')
    print(f'Next version: {next_version}')
    if release_branch_name is not None:
        print(f'Creating branch: {release_branch_name}')
    else:
        print('No release branch will be created for dev bump; CHANGELOG.md is unchanged.')
    print('Files to update:')
    for path, _ in updates:
        print(f'- {path.relative_to(REPO_ROOT)}')
    print(f'Commit message: bump: {next_version}')

    if args.dry_run:
        print('Dry run only. No branch, file, or commit changes were made.')
        return 0

    ensure_clean_worktree()
    try:
        if release_branch_name is not None:
            run_git_command(args=['checkout', '-b', release_branch_name])
        for path, content in updates:
            write_text_file(path=path, content=content)
        run_git_command(args=['add', '--', *(str(path.relative_to(REPO_ROOT)) for path, _ in updates)])
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
    parser.add_argument('--date', dest='release_date', type=parse_release_date, help='Release date as YYYY-MM-DD (default: the local calendar date).')
    parser.add_argument('--allow-empty-changelog', action='store_true', help='Explicitly allow a release with no notable changes in Unreleased.')
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


def prepare_changelog(*, content: str, next_version: str, release_date: date, allow_empty: bool) -> str:
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
        tag, date_text = match.groups()
        try:
            tagged_date = date.fromisoformat(date_text)
        except ValueError as exc:
            raise SystemExit(f'Invalid changelog date on line {index + 1}: {date_text}') from exc
        version = tuple(int(part) for part in tag[1:].split('.'))
        if previous_version is not None and version >= previous_version:
            raise SystemExit('Changelog releases must be unique and ordered newest first.')
        previous_version = version
        releases.append((index, tag, tagged_date))
    if releases:
        latest_version = tuple(int(part) for part in releases[0][1][1:].split('.'))
        if tuple(int(part) for part in next_version.split('.')) <= latest_version:
            raise SystemExit(f'v{next_version} must be newer than the latest changelog release, {releases[0][1]}.')
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
            if re.match(r' {0,3}\[[ \t]*(?:Unreleased|v' + VERSION_CORE + r')[ \t]*\]:', text, re.IGNORECASE):
                raise SystemExit('Changelog comparison links must use single-line Markdown definitions.')
            continue
        label = match.group(1)
        group = 'angle' if match.group('angle') is not None else 'bare'
        url = match.group(group)
        key = ' '.join(label.split()).casefold()
        if key in references:
            raise SystemExit(f'Duplicate changelog link definition: [{label}]')
        references[key] = (index, url, *match.span(group))

    if f'v{next_version}' in references:
        raise SystemExit(f'A changelog link for v{next_version} already exists.')

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
    if not has_notes and not allow_empty:
        raise SystemExit('Unreleased has no release notes. Add reviewed English notes, or use --allow-empty-changelog for a release with no notable changes.')

    newline = '\r\n' if lines[headings[0][0]].endswith('\r\n') else '\n'
    if 'unreleased' in references:
        index, url, url_start, url_end = references['unreleased']
        if index < end or (releases and index < releases[-1][0]):
            raise SystemExit('Place changelog comparison link definitions after the release sections.')
        match = re.fullmatch(r'(.+/compare/)([^\s]+)\.\.\.([^\s]+)', url)
        if match is None or not releases or match.group(2) != releases[0][1]:
            raise SystemExit('The Unreleased comparison link must start at the latest changelog tag.')
        prefix, previous_tag, target = match.groups()
        lines[index] = (
            lines[index][:url_start] + f'{prefix}v{next_version}...{target}' + lines[index][url_end:].rstrip('\r\n') + newline
            + f'[v{next_version}]: {prefix}{previous_tag}...v{next_version}{newline}'
        )
    notes = ''.join(lines[start:end]).strip('\r\n')
    prefix = ''.join(lines[:start]).rstrip('\r\n') + newline + newline
    section = f'## [v{next_version}] - {release_date.isoformat()}{newline}{newline}'
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


def run_git_command(*, args: list[str], capture_output: bool = False) -> str:
    completed = subprocess.run(['git', *args], cwd=REPO_ROOT, check=False, capture_output=capture_output, text=True)
    if completed.returncode != 0:
        stderr = completed.stderr.strip() if completed.stderr is not None else ''
        raise SystemExit(stderr or f'Git command failed: git {" ".join(args)}')
    if capture_output:
        return completed.stdout
    return ''


if __name__ == '__main__':
    sys.exit(main())
