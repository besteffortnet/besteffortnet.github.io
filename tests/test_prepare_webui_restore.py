from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "prepare-webui-restore.py"


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


class PrepareWebUIRestoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="webui-restore-test-")
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-b", "main"], cwd=self.repo, check=True, capture_output=True)
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "other.txt").write_bytes(b"other pre-catalog\n")
        self.no_catalog = self.commit("before catalog file")
        git(self.repo, "tag", "before-catalog", self.no_catalog)

        (self.repo / "webui-apps.html").write_bytes(b"catalog v0\n")
        (self.repo / "other.txt").write_bytes(b"other v0\n")
        self.v0 = self.commit("version without row order")
        git(self.repo, "tag", "catalog-no-row-order", self.v0)

        (self.repo / "webui-apps.html").write_bytes(b"catalog v1\n")
        (self.repo / "row-order.js").write_bytes(b"row order v1\n")
        (self.repo / "row-order.js").chmod(0o755)
        (self.repo / "other.txt").write_bytes(b"other v1\n")
        self.v1 = self.commit("version with row order")
        git(self.repo, "tag", "catalog-with-row-order", self.v1)

        (self.repo / "webui-apps.html").write_bytes(b"catalog current\n")
        (self.repo / "row-order.js").write_bytes(b"row order current\n")
        (self.repo / "other.txt").write_bytes(b"other current\n")
        self.head = self.commit("current version")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def commit(self, message: str) -> str:
        subprocess.run(["git", "add", "-A"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-m", message], cwd=self.repo, check=True, capture_output=True)
        return git(self.repo, "rev-parse", "HEAD")

    def invoke(self, ref: str, path: Path, branch: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                ref,
                "--repo",
                str(self.repo),
                "--worktree-path",
                str(path),
                "--branch",
                branch,
            ],
            text=True,
            capture_output=True,
        )

    def make_original_dirty(self) -> tuple[str, str, str]:
        (self.repo / "webui-apps.html").write_bytes(b"user dirty catalog\n")
        (self.repo / "row-order.js").write_bytes(b"user dirty row order\n")
        (self.repo / "private-note.tmp").write_bytes(b"untracked marker\n")
        return (
            git(self.repo, "status", "--porcelain=v1", "--untracked-files=all"),
            (self.repo / "webui-apps.html").read_text(),
            (self.repo / "row-order.js").read_text(),
        )

    def test_old_tag_removes_absent_row_order_and_preserves_dirty_original(self) -> None:
        original_status, dirty_html, dirty_js = self.make_original_dirty()
        worktree = self.root / "restore-v0"
        result = self.invoke("catalog-no-row-order", worktree, "restore/no-row-order")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)

        self.assertEqual((worktree / "webui-apps.html").read_bytes(), b"catalog v0\n")
        self.assertFalse((worktree / "row-order.js").exists())
        self.assertEqual((worktree / "other.txt").read_bytes(), b"other current\n")
        self.assertEqual(git(worktree, "rev-parse", "HEAD"), self.head)
        self.assertEqual(set(git(worktree, "diff", "--name-only").splitlines()), {"webui-apps.html", "row-order.js"})

        self.assertEqual((self.repo / "webui-apps.html").read_text(), dirty_html)
        self.assertEqual((self.repo / "row-order.js").read_text(), dirty_js)
        self.assertEqual(git(self.repo, "status", "--porcelain=v1", "--untracked-files=all"), original_status)
        self.assertTrue((self.repo / "private-note.tmp").exists())
        self.assertEqual(output["files"][1]["present"], False)
        self.assertFalse(output["publish_push_merge_performed"])
        self.assertIn("normal commit/push/PR workflow", output["next_steps"][-1])
        self.assertNotIn("human-reviewed", output["next_steps"][-1])

    def test_tag_with_row_order_restores_exact_bytes_and_only_allowed_files(self) -> None:
        self.make_original_dirty()
        worktree = self.root / "restore-v1"
        result = self.invoke("catalog-with-row-order", worktree, "restore/with-row-order")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)

        self.assertEqual((worktree / "webui-apps.html").read_bytes(), b"catalog v1\n")
        self.assertEqual((worktree / "row-order.js").read_bytes(), b"row order v1\n")
        self.assertEqual((worktree / "row-order.js").stat().st_mode & 0o777, 0o755)
        self.assertEqual((worktree / "other.txt").read_bytes(), b"other current\n")
        self.assertEqual(set(git(worktree, "diff", "--name-only").splitlines()), {"webui-apps.html", "row-order.js"})
        self.assertEqual(output["target_commit"], self.v1)
        self.assertTrue(all(item["present"] for item in output["files"]))
        self.assertEqual((self.repo / "webui-apps.html").read_bytes(), b"user dirty catalog\n")

    def test_invalid_ref_does_not_create_branch_or_worktree(self) -> None:
        worktree = self.root / "invalid-target"
        result = self.invoke("does-not-exist", worktree, "restore/invalid")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(worktree.exists())
        self.assertNotEqual(
            subprocess.run(["git", "show-ref", "--verify", "--quiet", "refs/heads/restore/invalid"], cwd=self.repo).returncode,
            0,
        )

    def test_version_without_catalog_file_is_rejected(self) -> None:
        worktree = self.root / "no-catalog-target"
        result = self.invoke("before-catalog", worktree, "restore/no-catalog")
        self.assertEqual(result.returncode, 2)
        self.assertIn("webui-apps.html", result.stderr)
        self.assertFalse(worktree.exists())
        self.assertNotEqual(
            subprocess.run(["git", "show-ref", "--verify", "--quiet", "refs/heads/restore/no-catalog"], cwd=self.repo).returncode,
            0,
        )

    def test_branch_name_is_not_accepted_as_a_commit_or_tag(self) -> None:
        worktree = self.root / "branch-ref-target"
        result = self.invoke("main", worktree, "restore/branch-ref")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(worktree.exists())

    def test_unreachable_commit_is_rejected(self) -> None:
        orphan = self.root / "orphan"
        orphan.mkdir()
        subprocess.run(["git", "init", "-b", "orphan"], cwd=orphan, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=orphan, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=orphan, check=True)
        (orphan / "empty").write_text("orphan\n")
        subprocess.run(["git", "add", "empty"], cwd=orphan, check=True)
        subprocess.run(["git", "commit", "-m", "unreachable"], cwd=orphan, check=True, capture_output=True)
        unreachable = git(orphan, "rev-parse", "HEAD")
        subprocess.run(["git", "fetch", str(orphan), "orphan"], cwd=self.repo, check=True, capture_output=True)
        worktree = self.root / "unreachable-target"
        result = self.invoke(unreachable, worktree, "restore/unreachable")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(worktree.exists())

    def test_existing_worktree_path_or_branch_is_never_overwritten(self) -> None:
        occupied = self.root / "occupied"
        occupied.mkdir()
        result = self.invoke("catalog-no-row-order", occupied, "restore/occupied-path")
        self.assertEqual(result.returncode, 2)
        self.assertTrue(occupied.is_dir())

        git(self.repo, "branch", "restore/existing-branch", self.head)
        destination = self.root / "branch-collision"
        result = self.invoke("catalog-no-row-order", destination, "restore/existing-branch")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(destination.exists())

        git(self.repo, "update-ref", "refs/remotes/origin/restore/remote-branch", self.head)
        remote_destination = self.root / "remote-branch-collision"
        result = self.invoke("catalog-no-row-order", remote_destination, "restore/remote-branch")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(remote_destination.exists())

    def test_selected_symlink_entry_is_rejected_before_worktree_creation(self) -> None:
        (self.repo / "row-order.js").unlink()
        os.symlink("external-target", self.repo / "row-order.js")
        bad_commit = self.commit("unsafe symlink version")
        git(self.repo, "tag", "bad-symlink", bad_commit)
        worktree = self.root / "symlink-target"
        result = self.invoke("bad-symlink", worktree, "restore/symlink")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(worktree.exists())


if __name__ == "__main__":
    unittest.main()
