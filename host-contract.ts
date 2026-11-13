// Host contract for the Team plugin's singular `bb.host` entry.
//
// The entry is a thin, validated bridge between the plugin server and the
// tools that only exist on the machine holding the project's canonical
// checkout:
//
// - `bd`: run a restricted Beads CLI invocation in the project directory.
//   Team work packages live in the project's existing Beads database; the
//   plugin never migrates, syncs, or writes the database directly — every
//   mutation goes through the CLI, and initialization happens only through
//   the separate, fixed-argv `bdInit` operation.
// - `gitState`: read-only git snapshot (branch, HEAD, dirty files, and a
//   content fingerprint) used for task checkpoints.
//
// The contract is shared by the server (`bb.hosts.experimental_client`) and
// the host entry (`host.ts`), so both sides validate the same shapes.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** bd subcommands the entry may run; anything else is refused before exec. */
export const BD_COMMANDS = [
  "list",
  "show",
  "create",
  "update",
  "delete",
  "ready",
  "where",
] as const;
export type BdCommand = (typeof BD_COMMANDS)[number];

/**
 * Strict per-command option grammar: flag → number of values it consumes.
 * Anything outside a command's table (unknown or equals-form flags, stray
 * positionals, cwd overrides like -C/--directory, database escapes like
 * --db/--global, destructive --cascade) is refused before exec. A flag's
 * values are consumed blindly, so a user field that happens to look like a
 * flag string is a value, never misclassified as a flag.
 */
const BD_COMMAND_GRAMMAR: Record<
  BdCommand,
  {
    flags: Record<string, number>;
    positionals: readonly [min: number, max: number];
  }
> = {
  list: {
    flags: {
      "--all": 0,
      "--brief": 0,
      "--limit": 1,
      "-n": 1,
      "--label": 1,
      "--label-any": 1,
    },
    positionals: [0, 0],
  },
  show: { flags: {}, positionals: [1, 1] },
  create: {
    flags: {
      "-t": 1,
      "--type": 1,
      "-a": 1,
      "--assignee": 1,
      "-l": 1,
      "--labels": 1,
      "-d": 1,
      "--description": 1,
      "-s": 1,
      "--status": 1,
      "--metadata": 1,
    },
    positionals: [1, 1],
  },
  update: {
    flags: {
      "--title": 1,
      "-d": 1,
      "--description": 1,
      "-s": 1,
      "--status": 1,
      "-a": 1,
      "--assignee": 1,
      "--add-label": 1,
      "--remove-label": 1,
      "--set-metadata": 1,
      "--unset-metadata": 1,
      "--metadata": 1,
    },
    positionals: [1, 16],
  },
  delete: { flags: { "--force": 0, "--dry-run": 0 }, positionals: [1, 16] },
  ready: {
    flags: {
      "--limit": 1,
      "-n": 1,
      "--label": 1,
      "--label-any": 1,
      "--brief": 0,
    },
    positionals: [0, 0],
  },
  where: { flags: {}, positionals: [0, 0] },
};

/** Read-only dependency lookup: `bd dep list <ids...>` (down direction). */
const BD_DEP_LIST_GRAMMAR: {
  flags: Record<string, number>;
  positionals: readonly [min: number, max: number];
} = {
  flags: { "--direction": 1, "--type": 1, "-t": 1 },
  positionals: [1, 16],
} as const;

/** Validate an argv (subcommand + flags + values) against the grammar. */
export function parseBdArgs(
  args: readonly string[],
): { ok: true } | { ok: false; error: string } {
  let command = args[0];
  let rest = args.slice(1);
  let spec = BD_COMMAND_GRAMMAR[command as BdCommand];
  // The only compound form: dep is allowed for the read-only `dep list`,
  // never dep add/remove or any other dep subcommand.
  if (command === "dep") {
    if (rest[0] !== "list") {
      return { ok: false, error: 'bd dep: only "dep list" is allowed' };
    }
    spec = BD_DEP_LIST_GRAMMAR;
    rest = rest.slice(1);
  }
  if (!spec) {
    return {
      ok: false,
      error: `bd subcommand "${command}" is not allowed (${BD_COMMANDS.join(" | ")})`,
    };
  }
  let positionals = 0;
  let index = 0;
  while (index < rest.length) {
    const token = rest[index]!;
    const arity = spec.flags[token];
    if (arity !== undefined) {
      if (index + arity >= rest.length) {
        return {
          ok: false,
          error: `bd ${command}: flag "${token}" is missing its value`,
        };
      }
      index += arity + 1;
      continue;
    }
    if (positionals < spec.positionals[1]) {
      if (token.startsWith("-")) {
        return { ok: false, error: `bd ${command}: unknown flag "${token}"` };
      }
      positionals += 1;
      index += 1;
      continue;
    }
    return {
      ok: false,
      error: `bd ${command}: unexpected argument "${token}"`,
    };
  }
  if (positionals < spec.positionals[0]) {
    return { ok: false, error: `bd ${command}: missing required argument` };
  }
  return { ok: true };
}

/** Absolute path on POSIX or Windows (no node dependency: shared by both sides). */
const absolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => /^(?:[A-Za-z]:[\\/]|\/)/.test(value),
    "cwd must be an absolute path",
  );

const bdInput = z
  .object({
    /** Project directory (the canonical checkout); must exist on the host. */
    cwd: absolutePath,
    /** bd subcommand and its flags, e.g. ["list","--all","--limit","0"]. */
    args: z.array(z.string().min(1)).min(1).max(64),
  })
  .strict()
  .superRefine((input, ctx) => {
    const parsed = parseBdArgs(input.args);
    if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
  });

/** Raw stdio + exit code of one completed child process; the caller decides what an error means. */
const execOutcome = z
  .object({
    ok: z.boolean(),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

export const hostContract = defineRpcContract({
  /**
   * Run `bd --sandbox --json --no-color <args...>` in `cwd`. The entry adds
   * the global flags itself (`--sandbox` disables Dolt auto-push), accepts
   * no executable or shell, and returns the raw stdio with the exit code:
   * the caller decides what an error means. No auto-init, no fallback.
   */
  bd: {
    experimental_description:
      "Run one restricted bd (Beads) CLI invocation in the project directory.",
    input: bdInput,
    output: execOutcome,
  },
  /**
   * Run the single fixed initialization `bd --sandbox --json --no-color
   * init --non-interactive --skip-agents --skip-hooks --stealth
   * --init-if-missing` in `cwd`. The argv is fixed by the entry — the
   * input carries no executable, no shell, and no arguments at all — and
   * the entry refuses when `cwd` is a linked git worktree (an execution
   * worktree), so no second database can be created outside the canonical
   * checkout. `--init-if-missing` is bd's own idempotence: an
   * already-initialized workspace is skipped with exit 0 instead of
   * failing. `--stealth` keeps the bootstrap out of the user's git history:
   * no commit, nothing staged, no tracked or untracked file touched — bd
   * only appends its marked blocks to the repository's .git/info/exclude
   * (and its global git config is untouched).
   */
  bdInit: {
    experimental_description:
      "Initialize the missing Beads database with a fixed bd init invocation.",
    input: z.object({ cwd: absolutePath }).strict(),
    output: execOutcome,
  },
  /**
   * Read-only git state of `cwd`: branch (null when detached), HEAD commit,
   * dirty file paths, and a fingerprint over HEAD/branch plus the staged and
   * unstaged binary diffs and the contents of untracked files. Editing a
   * dirty or untracked file without renaming it changes the fingerprint.
   */
  gitState: {
    experimental_description:
      "Read the git branch, HEAD, dirty files, and state fingerprint.",
    input: z.object({ cwd: absolutePath }).strict(),
    output: z
      .object({
        branch: z.string().nullable(),
        commit: z.string(),
        fingerprint: z.string(),
        dirtyFiles: z.array(z.string()),
      })
      .strict(),
  },
});

export type BdInput = z.infer<typeof bdInput>;
export type GitStateOutput = z.infer<
  (typeof hostContract)["gitState"]["output"]
>;
