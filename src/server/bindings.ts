import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { listProjectThreads, readTeamMark } from "./core";
import { activeSessionKey, readReplacementIntent } from "./sessions";
import type { BindingIssue } from "../shared/snapshot";

/** Read only: never adopt, spawn, release queues or guess between candidates. */
export async function inspectBindings(bb: BbPluginApi, projectId: string, team: string, roles: string[]): Promise<BindingIssue[]> {
  const live = await listProjectThreads(bb, projectId);
  const metadata: Array<{threadId:string; metadata?:unknown}> = [];
  for (let i = 0; i < live.length; i += 200) metadata.push(...(await bb.sdk.threads.experimental_listPluginMetadata({threadIds:live.slice(i,i+200).map(t=>t.id)})).threads);
  const issues: BindingIssue[] = [];
  for (const role of roles) {
    const current = await bb.storage.kv.get<string>(activeSessionKey(projectId, team, role));
    const held = metadata.some(m => {
      const meta = m.metadata as Record<string,unknown> | undefined;
      const mark = readTeamMark(meta);
      return mark?.team === team && mark.role === role && !mark.helper && meta?.teamReplacement === true;
    });
    if (held) {
      issues.push({role,currentThreadId:current ?? "",candidates:[],state:"blocked"});
      continue;
    }
    if (!current || live.some(t => t.id === current)) continue;
    const candidates = live.filter(t => {
      const meta = metadata.find(m => m.threadId === t.id)?.metadata as Record<string, unknown> | undefined;
      const mark = readTeamMark(meta);
      return mark?.team === team && mark.role === role && !mark.helper && meta?.teamRetired !== true && meta?.teamReplacement !== true;
    });
    let state: BindingIssue["state"] = "blocked";
    const intent = await readReplacementIntent(bb, projectId, team, role);
    // Unknown/deleted old thread is not proof of a completed replacement.
    try {
      const old = await bb.sdk.threads.get({threadId: current});
      if (old.projectId === projectId && old.archivedAt !== null && (!intent || intent.stage === "complete") && !held) {
        state = candidates.length === 0 ? "missing" : candidates.length > 1 ? "ambiguous" :
          candidates[0]!.environmentId === old.environmentId && old.environmentId !== null ? "repairable" : "blocked";
      }
    } catch { /* inspection cannot establish safety; expose blocked */ }
    issues.push({role, currentThreadId: current, candidates: candidates.map(t => t.id), state});
  }
  return issues;
}

/** Caller holds the team scope lock. Revalidate against stale UI and pause first. */
export async function repairBinding(bb: BbPluginApi, projectId: string, team: string, expected: BindingIssue): Promise<void> {
  const issue = (await inspectBindings(bb, projectId, team, [expected.role]))[0];
  if (!issue || issue.state !== "repairable" || issue.currentThreadId !== expected.currentThreadId || issue.candidates[0] !== expected.candidates[0]) {
    throw new Error("Session binding changed or is ambiguous. Refresh Team; no new thread was created.");
  }
  await bb.storage.kv.set(`role-paused:${projectId}:${team}:${issue.role}`, true);
  await bb.storage.kv.set(activeSessionKey(projectId, team, issue.role), issue.candidates[0]!);
}
