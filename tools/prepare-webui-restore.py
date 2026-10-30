#!/usr/bin/env python3
"""Create an isolated review worktree with two files restored from a commit/tag.

This prepares a local diff only. It never commits, pushes, merges, or changes the
caller's current worktree. The new worktree starts at the selected base commit
(HEAD by default); only webui-apps.html and row-order.js are copied from the
requested historical commit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path


ALLOWED_PATHS = ("webui-apps.html", "row-order.js")
MAX_FILE_BYTES = 16 * 1024 * 1024


class RestoreError(Exception):
    """A safe, user-facing validation or preparation error."""


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        ["git", *args], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    if check and result.returncode != 0:
        raise RestoreError(f"git command failed: git {' '.join(args[:2])}")
    return result


def resolve_commit(repo: Path, ref: str, *, target_only: bool = False) -> str:
    if not ref or ref.startswith("-") or "\x00" in ref:
        raise RestoreError("ref must be a commit SHA or tag name")
    if re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", ref):
        commitish = ref
    elif not target_only:
        commitish = ref
    else:
        tag_ref = ref if ref.startswith("refs/tags/") else f"refs/tags/{ref}"
        valid_tag = git(repo, "check-ref-format", tag_ref, check=False)
        if valid_tag.returncode != 0:
            raise RestoreError("ref must be an exact commit SHA or an existing tag")
        commitish = tag_ref
    result = git(repo, "rev-parse", "--verify", "--end-of-options", f"{commitish}^{{commit}}", check=False)
    if result.returncode != 0:
        raise RestoreError("ref does not resolve to a commit")
    commit = result.stdout.decode("ascii", "strict").strip()
    if len(commit) not in (40, 64) or any(ch not in "0123456789abcdef" for ch in commit.lower()):
        raise RestoreError("Git returned an invalid commit id")
    return commit


def tree_files(repo: Path, commit: str) -> dict[str, tuple[str, str] | None]:
    result = git(repo, "ls-tree", "-z", commit, "--", *ALLOWED_PATHS)
    found: dict[str, tuple[str, str] | None] = {name: None for name in ALLOWED_PATHS}
    for raw in result.stdout.split(b"\0"):
        if not raw:
            continue
        try:
            metadata, raw_name = raw.split(b"\t", 1)
            mode, kind, oid = metadata.decode("ascii").split(" ")
            name = raw_name.decode("utf-8", "strict")
        except (ValueError, UnicodeDecodeError) as exc:
            raise RestoreError("could not parse the selected Git tree") from exc
        if name not in found:
            raise RestoreError("Git returned an unexpected path")
        if kind != "blob" or mode not in ("100644", "100755"):
            raise RestoreError(f"{name} is not a regular file in the selected version")
        found[name] = (mode, oid)
    return found


def read_blob(repo: Path, oid: str) -> bytes:
    result = git(repo, "cat-file", "blob", oid)
    if len(result.stdout) > MAX_FILE_BYTES:
        raise RestoreError("selected file exceeds the 16 MiB safety limit")
    return result.stdout


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_file_atomically(path: Path, data: bytes, mode: int) -> None:
    if path.exists() and not (path.is_file() or path.is_symlink()):
        raise RestoreError(f"destination {path.name} is not a regular file")
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.restore-", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def apply_historical_files(repo: Path, worktree: Path, entries: dict[str, tuple[str, str] | None]) -> list[dict[str, object]]:
    manifest: list[dict[str, object]] = []
    for name in ALLOWED_PATHS:
        destination = worktree / name
        entry = entries[name]
        if entry is None:
            if destination.exists() or destination.is_symlink():
                if destination.is_dir() and not destination.is_symlink():
                    raise RestoreError(f"destination {name} is a directory")
                destination.unlink()
            manifest.append({"path": name, "present": False, "sha256": None})
            continue
        mode_text, oid = entry
        contents = read_blob(repo, oid)
        write_file_atomically(destination, contents, 0o755 if mode_text == "100755" else 0o644)
        if destination.read_bytes() != contents:
            raise RestoreError(f"readback mismatch for {name}")
        manifest.append({"path": name, "present": True, "sha256": sha256(contents), "mode": mode_text})
    return manifest


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare a two-file historical restore diff in a new Git worktree."
    )
    parser.add_argument("ref", help="reachable Git commit SHA or tag")
    parser.add_argument("--repo", type=Path, required=True, help="the webui-apps Git checkout")
    parser.add_argument("--worktree-path", type=Path, required=True, help="a new, nonexistent path outside the repository")
    parser.add_argument("--branch", required=True, help="a new branch name for the isolated worktree")
    parser.add_argument("--base-ref", default="HEAD", help="commit to use as the new branch base (default: HEAD)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    created_worktree: Path | None = None
    try:
        repo = args.repo.resolve(strict=True)
        root_text = git(repo, "rev-parse", "--show-toplevel").stdout.decode("utf-8", "strict").strip()
        root = Path(root_text).resolve(strict=True)
        if repo != root:
            repo = root

        target_commit = resolve_commit(repo, args.ref, target_only=True)
        base_commit = resolve_commit(repo, args.base_ref)
        ancestry = git(repo, "merge-base", "--is-ancestor", target_commit, base_commit, check=False)
        if ancestry.returncode != 0:
            raise RestoreError("target commit is not reachable from the selected base history")

        entries = tree_files(repo, target_commit)
        if entries["webui-apps.html"] is None:
            raise RestoreError("selected version does not contain webui-apps.html; refusing to prepare restoration")
        for entry in entries.values():
            if entry is not None:
                read_blob(repo, entry[1])

        branch_check = git(repo, "check-ref-format", "--branch", args.branch, check=False)
        if branch_check.returncode != 0:
            raise RestoreError("branch name is invalid")
        refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes").stdout.decode("utf-8", "strict").splitlines()
        local_branch_ref = f"refs/heads/{args.branch}"
        remote_suffix = f"/{args.branch}"
        if local_branch_ref in refs or any(
            ref.startswith("refs/remotes/") and ref.endswith(remote_suffix) for ref in refs
        ):
            raise RestoreError("branch name already exists locally or remotely; refusing to reuse it")

        raw_destination = args.worktree_path.expanduser()
        if raw_destination.exists() or raw_destination.is_symlink():
            raise RestoreError("worktree path already exists; refusing to overwrite it")
        parent = raw_destination.parent.resolve(strict=True)
        destination = parent / raw_destination.name
        if destination == root or destination in root.parents or root in destination.parents:
            raise RestoreError("worktree path must be separate from the source repository")

        added = git(repo, "worktree", "add", "-b", args.branch, str(destination), base_commit, check=False)
        if added.returncode != 0:
            raise RestoreError("Git could not create the requested worktree/branch; no files were overwritten")
        created_worktree = destination

        manifest = apply_historical_files(repo, destination, entries)
        changed = git(destination, "diff", "--name-only", "--", *ALLOWED_PATHS).stdout.decode("utf-8", "strict").splitlines()
        all_changed = git(destination, "status", "--porcelain=v1", "--untracked-files=all").stdout.decode("utf-8", "strict").splitlines()
        unexpected = []
        for line in all_changed:
            path = line[3:] if len(line) >= 4 else ""
            if path not in ALLOWED_PATHS:
                unexpected.append(path)
        if unexpected:
            raise RestoreError("new worktree contains an unexpected change; it was preserved for inspection")

        result = {
            "ok": True,
            "base_commit": base_commit,
            "target_commit": target_commit,
            "branch": args.branch,
            "worktree_path": str(destination),
            "files": manifest,
            "changed_paths": changed,
            "original_worktree_modified": False,
            "publish_push_merge_performed": False,
            "next_steps": [
                f"git -C {shlex.quote(str(destination))} status --short",
                f"git -C {shlex.quote(str(destination))} diff -- {shlex.quote(ALLOWED_PATHS[0])} {shlex.quote(ALLOWED_PATHS[1])}",
                "Review the diff and run the repository's checks; then use the repository's normal commit/push/PR workflow.",
            ],
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, UnicodeError, RestoreError) as exc:
        error: dict[str, object] = {"ok": False, "error": str(exc)}
        if created_worktree is not None:
            error["preserved_worktree_path"] = str(created_worktree)
        print(json.dumps(error, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
