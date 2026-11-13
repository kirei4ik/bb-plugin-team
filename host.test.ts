// Host entry tests: bd allowlist/failure shape, abort, and gitState
// fingerprint sensitivity (dirty and untracked content changes).

import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  afterEach,
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const run = promisify(execFile);
const bdAvailable = spawnSync("bd", ["--version"]).status === 0;
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function gitRepo(): Promise<string> {
  const dir = await tempDir("host-git-");
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "committed.txt"), "base\n");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function bdRepo(): Promise<string> {
  const dir = await tempDir("host-bd-");
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("bd", ["init"], { cwd: dir });
  return dir;
}

describe("host entry", () => {
  let harness: ReturnType<typeof experimental_createHostEntryHarness>;
  const dirs: string[] = [];

  beforeEach(() => {
    harness = experimental_createHostEntryHarness(hostEntry);
  });
  afterEach(async () => {
    await harness.experimental_dispose();
  });
  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const call = <T>(
    method: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<T> =>
    harness.experimental_call(method as never, input as never, {
      signal,
    }) as Promise<T>;

  describe.skipIf(!bdAvailable)("bd", () => {
    let repo: string;
    beforeAll(async () => {
      repo = await bdRepo();
      dirs.push(repo);
    });

    it("runs an allowlisted command and returns parsed output", async () => {
      const created = await call<{ ok: boolean; stdout: string }>("bd", {
        cwd: repo,
        args: [
          "create",
          "Probe",
          "--type",
          "task",
          "-a",
          "dev",
          "-l",
          "bb-team:x",
        ],
      });
      expect(created.ok).toBe(true);
      const issue = JSON.parse(created.stdout) as { id: string };
      const listed = await call<{ stdout: string; ok: boolean }>("bd", {
        cwd: repo,
        args: ["list", "--all", "--limit", "0", "--label", "bb-team:x"],
      });
      expect(listed.ok).toBe(true);
      expect(
        (JSON.parse(listed.stdout) as Array<{ id: string }>).map(
          (row) => row.id,
        ),
      ).toContain(issue.id);
    });

    it("reports a nonzero exit explicitly (no auto-init, no fallback)", async () => {
      const dir = await tempDir("host-bd-empty-");
      dirs.push(dir);
      const result = await call<{
        ok: boolean;
        exitCode: number;
        stderr: string;
      }>("bd", {
        cwd: dir,
        args: ["list", "--all", "--limit", "0"],
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("no beads database found");
    });

    it("refuses subcommands outside the allowlist", async () => {
      // Schema validation rejects before any process is spawned; cwd
      // need not exist for these.
      const dir = await tempDir("host-nobd-");
      for (const args of [
        ["sync"],
        ["sql", "select 1"],
        ["init"],
        ["", "list"],
      ]) {
        await expect(call("bd", { cwd: dir, args })).rejects.toThrow();
      }
    });

    it("refuses flags that escape the project, override cwd, or cascade", async () => {
      const dir = await tempDir("host-nobd-");
      for (const args of [
        ["list", "--db", "/tmp/other.db"],
        ["list", "--db=/tmp/other.db"],
        ["list", "--global"],
        ["list", "-C", "/other"],
        ["list", "--directory=/other"],
        ["delete", "bd-1", "--cascade", "--force"],
        ["delete", "bd-1", "--from-file", "/tmp/x"],
        ["update", "bd-1", "--set-labels", "x"],
      ]) {
        await expect(call("bd", { cwd: dir, args })).rejects.toThrow();
      }
    });

    it("treats flag-like values as values, not flags", async () => {
      const created = await call<{ ok: boolean; stdout: string }>("bd", {
        cwd: repo,
        args: ["create", "Probe", "-d", "--db /tmp/other.db"],
      });
      expect(created.ok).toBe(true);
      const issue = JSON.parse(created.stdout) as {
        id: string;
        description: string;
      };
      expect(issue.description).toBe("--db /tmp/other.db");
      // A positional that looks like a flag is refused (bd would, too).
      await expect(
        call("bd", { cwd: repo, args: ["create", "--all"] }),
      ).rejects.toThrow();
    });

    it("rejects a non-absolute cwd and an aborted signal", async () => {
      await expect(
        call("bd", { cwd: "relative/path", args: ["where"] }),
      ).rejects.toThrow();
      const controller = new AbortController();
      controller.abort();
      await expect(
        call("bd", { cwd: repo, args: ["where"] }, controller.signal),
      ).rejects.toThrow(/abort/i);
    });
  });

  describe.skipIf(!bdAvailable)("bdInit", () => {
    it("initializes a missing database with the fixed argv (no AGENTS.md, no hooks)", async () => {
      const dir = await tempDir("host-bdinit-");
      dirs.push(dir);
      await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
      const result = await call<{
        ok: boolean;
        exitCode: number;
        stdout: string;
      }>("bdInit", { cwd: dir });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, ".beads", "config.yaml"))).toBe(true);
      // --skip-agents: no AGENTS.md is generated; --skip-hooks: no hooks
      // are installed (only git's own *.sample templates remain).
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
      const hooks = await readdir(join(dir, ".git", "hooks"));
      expect(hooks.every((name) => name.endsWith(".sample"))).toBe(true);
      // The database is immediately usable through the bd operation.
      const list = await call<{ ok: boolean }>("bd", {
        cwd: dir,
        args: ["list", "--all", "--limit", "0"],
      });
      expect(list.ok).toBe(true);
    });

    it("is stealth: no commit, staged/untracked files and HEAD untouched", async () => {
      const dir = await tempDir("host-bdinit-stealth-");
      dirs.push(dir);
      const git = (args: readonly string[]) => run("git", args, { cwd: dir });
      await git(["init", "-q", "-b", "main"]);
      await git(["config", "user.email", "t@example.com"]);
      await git(["config", "user.name", "t"]);
      await writeFile(join(dir, "tracked.txt"), "base\n");
      await git(["add", "tracked.txt"]);
      await git(["commit", "-qm", "base"]);
      // A staged modification plus user's untracked files, including a
      // foreign AGENTS.md that a plain init would absorb into its commit.
      await writeFile(join(dir, "tracked.txt"), "staged-change\n");
      await git(["add", "tracked.txt"]);
      await writeFile(join(dir, "AGENTS.md"), "Keep me\n");
      await writeFile(join(dir, ".gitignore"), "node_modules\n");
      const headBefore = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const indexBefore = (await git(["ls-files", "-s"])).stdout;
      const result = await call<{ ok: boolean; exitCode: number }>("bdInit", {
        cwd: dir,
      });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      // No commit, nothing staged or unstaged by bd, no new history.
      expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(
        headBefore,
      );
      const log = (await git(["log", "--oneline"])).stdout.trim();
      expect(log.split("\n")).toHaveLength(1);
      expect(log.endsWith("base")).toBe(true);
      expect((await git(["ls-files", "-s"])).stdout).toBe(indexBefore);
      const status = (await git(["status", "--porcelain"])).stdout;
      expect(status).toContain("M  tracked.txt");
      expect(status).toContain("?? AGENTS.md");
      expect(status).toContain("?? .gitignore");
      // .beads itself stays local and invisible via .git/info/exclude.
      expect(status).not.toContain(".beads");
      expect(existsSync(join(dir, ".beads", "config.yaml"))).toBe(true);
      const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain("# Beads stealth mode (added by bd init --stealth)");
      expect(exclude).toContain(".beads/");
      // User files are byte-identical; the user's .gitignore is untouched.
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("Keep me\n");
      expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(
        "node_modules\n",
      );
    });

    it("is idempotent on an initialized workspace (skip, exit 0)", async () => {
      const dir = await tempDir("host-bdinit-again-");
      dirs.push(dir);
      await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
      const first = await call<{ ok: boolean }>("bdInit", { cwd: dir });
      expect(first.ok).toBe(true);
      const excludeAfterFirst = await readFile(
        join(dir, ".git", "info", "exclude"),
        "utf8",
      );
      const second = await call<{ ok: boolean; exitCode: number }>("bdInit", {
        cwd: dir,
      });
      // bd's --init-if-missing: an existing workspace is skipped, not failed.
      expect(second.ok).toBe(true);
      expect(second.exitCode).toBe(0);
      // Nothing is appended a second time.
      expect(
        await readFile(join(dir, ".git", "info", "exclude"), "utf8"),
      ).toBe(excludeAfterFirst);
    });

    it("accepts no arguments, no extra fields, and no relative cwd", async () => {
      const dir = await tempDir("host-bdinit-strict-");
      dirs.push(dir);
      await expect(
        call("bdInit", { cwd: dir, args: ["--force"] }),
      ).rejects.toThrow();
      await expect(
        call("bdInit", { cwd: dir, flags: ["--reinit-local"] }),
      ).rejects.toThrow();
      await expect(call("bdInit", { cwd: "relative/path" })).rejects.toThrow();
      await expect(call("bdInit", {})).rejects.toThrow();
      // Nothing was initialized by the refused calls.
      expect(existsSync(join(dir, ".beads"))).toBe(false);
    });

    it("refuses a linked git worktree (execution worktree)", async () => {
      const main = await gitRepo();
      dirs.push(main);
      const worktree = `${main}-wt`;
      dirs.push(worktree);
      await run("git", ["worktree", "add", "-q", worktree, "-b", "wt"], {
        cwd: main,
      });
      await expect(call("bdInit", { cwd: worktree })).rejects.toThrow(
        /worktree/i,
      );
      // No second database was created outside the canonical checkout.
      expect(existsSync(join(worktree, ".beads"))).toBe(false);
    });
  });

  describe.skipIf(!gitAvailable)("gitState", () => {
    it("reports branch, commit, and a stable clean fingerprint", async () => {
      const dir = await gitRepo();
      dirs.push(dir);
      const state = await call<{
        branch: string | null;
        commit: string;
        fingerprint: string;
        dirtyFiles: string[];
      }>("gitState", { cwd: dir });
      expect(state.branch).toBe("main");
      expect(state.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(state.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(state.dirtyFiles).toEqual([]);
      const again = await call<{ fingerprint: string }>("gitState", {
        cwd: dir,
      });
      expect(again.fingerprint).toBe(state.fingerprint);
    });

    it("changes the fingerprint when a tracked file's content changes", async () => {
      const dir = await gitRepo();
      dirs.push(dir);
      const clean = await call<{ fingerprint: string; dirtyFiles: string[] }>(
        "gitState",
        {
          cwd: dir,
        },
      );
      // Same file name, different content: must be detected.
      await writeFile(join(dir, "committed.txt"), "changed\n");
      const dirty = await call<{ fingerprint: string; dirtyFiles: string[] }>(
        "gitState",
        {
          cwd: dir,
        },
      );
      expect(dirty.fingerprint).not.toBe(clean.fingerprint);
      expect(dirty.dirtyFiles).toContain("committed.txt");
      // Staging the change moves the fingerprint again.
      await run("git", ["add", "."], { cwd: dir });
      const staged = await call<{ fingerprint: string }>("gitState", {
        cwd: dir,
      });
      expect(staged.fingerprint).not.toBe(dirty.fingerprint);
    });

    it("changes the fingerprint when untracked content changes", async () => {
      const dir = await gitRepo();
      dirs.push(dir);
      const clean = await call<{ fingerprint: string; dirtyFiles: string[] }>(
        "gitState",
        {
          cwd: dir,
        },
      );
      await writeFile(join(dir, "fresh.txt"), "one\n");
      const added = await call<{ fingerprint: string; dirtyFiles: string[] }>(
        "gitState",
        {
          cwd: dir,
        },
      );
      expect(added.fingerprint).not.toBe(clean.fingerprint);
      expect(added.dirtyFiles).toContain("fresh.txt");
      // Same untracked file, new content without a rename: must be detected.
      await writeFile(join(dir, "fresh.txt"), "two\n");
      const edited = await call<{ fingerprint: string; dirtyFiles: string[] }>(
        "gitState",
        {
          cwd: dir,
        },
      );
      expect(edited.fingerprint).not.toBe(added.fingerprint);
      expect(edited.dirtyFiles).toContain("fresh.txt");
    });

    it("fails explicitly outside a git repository", async () => {
      const dir = await tempDir("host-nogit-");
      dirs.push(dir);
      await expect(call("gitState", { cwd: dir })).rejects.toThrow();
      await expect(
        call("gitState", { cwd: "relative/path" }),
      ).rejects.toThrow();
    });
  });
});
