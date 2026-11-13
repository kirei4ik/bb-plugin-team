// The Team plugin's singular `bb.host` entry (manifest: bb.host).
//
// Runs on the daemon of the host that holds a project's canonical checkout
// and exposes exactly three operations (see host-contract.ts):
//
// - bd: a restricted `bd --sandbox --json` CLI runner. The subcommand comes
//   from an allowlist, the executable is fixed, no shell is involved, the
//   working directory is the requested project directory, and the call has a
//   timeout and an output cap. Nothing is logged: bd stdio goes back to the
//   caller only.
// - bdInit: the single fixed `bd init --non-interactive --skip-agents
//   --skip-hooks --stealth --init-if-missing` bootstrap, used only by the
//   tracker's prepare after it proved the database is absent. --stealth
//   means no git commit and no touched user files (bd only appends its
//   marked blocks to .git/info/exclude); the entry refuses a linked git
//   worktree (execution worktree) so no second database can be created
//   outside the canonical checkout.
// - gitState: read-only git commands plus file reads under the same project
//   directory, summarized as a content fingerprint.
//
// The entry runs nothing outside the requested project directory, keeps no
// state, and performs no writes on its own (bdInit's write is bd's own,
// fixed init argv in the requested directory).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, lstat, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  experimental_defineHostEntry,
  experimental_sanitizeInheritedChildProcessEnv,
} from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract";

const BD_TIMEOUT_MS = 60_000;
/** Dolt bootstrap on first init can be slower than a plain query. */
const BD_INIT_TIMEOUT_MS = 120_000;
/** Bounded so the validated JSON response stays under the SDK's 8 MiB RPC cap. */
const BD_MAX_BUFFER = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

interface ExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * execFile without a shell, with timeout/maxBuffer, honoring abort.
 * Rejects on abort, timeout, spawn failures (ENOENT), and output-cap
 * errors; resolves with the exit code only for a completed process.
 */
function exec(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxBuffer: number,
  signal: AbortSignal,
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        signal,
        windowsHide: true,
        env: (() => {
          const env = experimental_sanitizeInheritedChildProcessEnv({
            env: process.env,
          });
          // Project selection must not inherit another shell's repository/database.
          for (const key of [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_EXTERNAL_DIFF",
          ])
            delete env[key];
          env.GIT_OPTIONAL_LOCKS = "0";
          if (command === "bd") env.BEADS_DIR = join(cwd, ".beads");
          return env;
        })(),
      },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(new Error(`${command} ${args[0]} aborted`));
          return;
        }
        if (error) {
          // Spawn failures (ENOENT) and output-cap errors carry a string
          // error.code; timeouts are killed. Both are explicit failures.
          if (error.killed || typeof error.code !== "number") {
            reject(
              new Error(
                `${command} ${args[0]} failed in ${cwd}: ${error.message}`,
              ),
            );
            return;
          }
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        resolve({ exitCode: 0, stdout, stderr });
      },
    );
  });
}

const assertAbsolute = (cwd: string): void => {
  if (!isAbsolute(cwd))
    throw new Error(`cwd must be an absolute path, got: ${cwd}`);
};

const handlers = {
  /** Restricted bd runner; see host-contract.ts for the argv policy. */
  async bd(
    input: { cwd: string; args: string[] },
    context: { signal: AbortSignal },
  ): Promise<{
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    assertAbsolute(input.cwd);
    const { exitCode, stdout, stderr } = await exec(
      "bd",
      ["--sandbox", "--json", "--no-color", ...input.args],
      input.cwd,
      BD_TIMEOUT_MS,
      BD_MAX_BUFFER,
      context.signal,
    );
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  },

  /**
   * Linked-worktree guard for bdInit: a `.git` file whose gitdir points
   * into another repository's `worktrees/` directory marks an execution
   * worktree. Initializing a second Beads database there is refused —
   * Beads belongs to the canonical checkout only. A missing `.git` (no
   * git, bd init bootstraps one) or a `.git` directory (plain checkout)
   * pass.
   */
  async assertNotExecutionWorktree(cwd: string): Promise<void> {
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(join(cwd, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    if (!stat.isFile()) return;
    const gitdir = (await readFile(join(cwd, ".git"), "utf8")).trim();
    if (/[/\\]\.git[/\\]worktrees[/\\]/.test(gitdir)) {
      throw new Error(
        `${cwd} is a linked git worktree (execution worktree); refusing to initialize a second Beads database outside the canonical checkout`,
      );
    }
  },

  /**
   * Fixed-argv Beads bootstrap; see host-contract.ts. With --stealth bd
   * makes no git commit, stages nothing, and touches no tracked or
   * untracked user file: it only appends its marked blocks to the repo's
   * own .git/info/exclude so the fresh .beads/ stays local. `--init-if-missing`
   * keeps the call idempotent (an initialized workspace is skipped with
   * exit 0).
   */
  async bdInit(
    input: { cwd: string },
    context: { signal: AbortSignal },
  ): Promise<{
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    assertAbsolute(input.cwd);
    await handlers.assertNotExecutionWorktree(input.cwd);
    const { exitCode, stdout, stderr } = await exec(
      "bd",
      [
        "--sandbox",
        "--json",
        "--no-color",
        "init",
        "--non-interactive",
        "--skip-agents",
        "--skip-hooks",
        "--stealth",
        "--init-if-missing",
      ],
      input.cwd,
      BD_INIT_TIMEOUT_MS,
      BD_MAX_BUFFER,
      context.signal,
    );
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  },

  /** Read-only git state with a content fingerprint; see host-contract.ts. */
  async gitState(
    input: { cwd: string },
    context: { signal: AbortSignal },
  ): Promise<{
    branch: string | null;
    commit: string;
    fingerprint: string;
    dirtyFiles: string[];
  }> {
    assertAbsolute(input.cwd);
    const cwd = input.cwd;
    const signal = context.signal;
    const git = (args: readonly string[]): Promise<ExecOutcome> =>
      exec("git", args, cwd, GIT_TIMEOUT_MS, GIT_MAX_BUFFER, signal);
    const ok = async (args: readonly string[]): Promise<string> => {
      const result = await git(args);
      if (result.exitCode !== 0) {
        throw new Error(
          `git ${args[0]} failed in ${cwd} (exit ${result.exitCode}): ${result.stderr.trim()}`,
        );
      }
      return result.stdout;
    };

    const commit = (await ok(["rev-parse", "HEAD"])).trim();
    if (!commit) throw new Error(`no HEAD commit in ${cwd}`);

    const rawBranch = (await ok(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const branch = rawBranch === "HEAD" || !rawBranch ? null : rawBranch;

    // Porcelain v1 -z: "XY path\0" records; renames/copies append the
    // pre-image path as a second, headerless NUL record.
    const status = await ok([
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
    ]);
    const records = status.split("\0");
    const dirtyFiles = new Set<string>();
    const untracked: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (!record) continue;
      const xy = record.slice(0, 2);
      const path = record.slice(3);
      dirtyFiles.add(path);
      if (xy === "??") untracked.push(path);
      if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C")
        index += 1;
    }
    const dirty = [...dirtyFiles].sort();
    for (const file of dirty) {
      try {
        if ((await lstat(join(cwd, file))).isDirectory())
          throw new Error(
            `Dirty submodule ${file} requires its own checkpoint; a parent repository fingerprint cannot prove its contents`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const staged = await ok([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--cached",
    ]);
    const unstaged = await ok([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
    ]);

    const hash = createHash("sha256");
    const feed = (chunk: string | Buffer): void => void hash.update(chunk);
    feed(`${branch ?? ""}\0${commit}\0${status}\0`);
    feed(staged);
    feed("\0");
    feed(unstaged);
    feed("\0");
    for (const file of untracked.sort()) {
      try {
        feed(file);
        feed("\0");
        const path = join(cwd, file);
        const stat = await lstat(path);
        feed(
          createHash("sha256")
            .update(
              stat.isSymbolicLink()
                ? await readlink(path)
                : await readFile(path),
            )
            .digest(),
        );
        feed("\0");
      } catch (error) {
        throw new Error(
          `Cannot fingerprint untracked path ${file}: ${(error as Error).message}`,
        );
      }
    }

    return {
      branch,
      commit,
      fingerprint: hash.digest("hex"),
      dirtyFiles: dirty,
    };
  },
};

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers,
});
