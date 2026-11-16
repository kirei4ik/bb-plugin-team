import { describe, expect, it } from "vitest";
import { deriveExecutionState, type ExecutionStateInput, type TeamTask } from "../../src/shared/snapshot";

const task: TeamTask = {id: "pkg-1", role: "dev", title: "Work", status: "in-progress", note: null, createdAtMs: 1, updatedAtMs: 42};
const input: ExecutionStateInput = {role: "dev", tasks: [task], replacement: null, autoContinue: null, threadStatus: "idle", threadUpdatedAtMs: 57};

describe("confirmed execution activity", () => {
  it.each(["idle", "pending", "stopping", "unknown", null])("does not claim activity for %s", (threadStatus) => {
    const result = deriveExecutionState({...input, threadStatus});
    expect(result).toMatchObject({kind: "waiting", taskId: task.id, atMs: 57});
    expect(task.status).toBe("in-progress");
  });
  it.each(["active", "starting"])("recognizes %s and keeps the linked task", (threadStatus) => {
    expect(deriveExecutionState({...input, threadStatus})).toMatchObject({kind: "working", taskId: task.id, atMs: 57});
  });
  it("exposes a failed session without calling it a handoff failure", () => {
    expect(deriveExecutionState({...input, threadStatus: "error"})).toMatchObject({kind: "error", errorCode: "session_failed", taskId: task.id, atMs: 57});
  });
  it("keeps submitted work awaiting acceptance when its session fails", () => {
    expect(deriveExecutionState({...input, tasks: [{...task, status: "review"}], threadStatus: "error"})).toMatchObject({kind: "awaiting-acceptance", taskId: task.id});
  });
  it("shows queued work and pauses without inventing an active turn", () => {
    expect(deriveExecutionState({...input, paused: true})).toMatchObject({kind: "waiting", errorCode: "paused"});
    expect(deriveExecutionState({...input, tasks: [], threadStatus: "pending"})).toMatchObject({kind: "waiting", errorCode: "session_pending"});
    expect(deriveExecutionState({...input, tasks: [{...task, status: "todo"}]})).toMatchObject({kind: "waiting", taskId: task.id});
  });
  it("uses confirmed timestamps consistently across snapshot reloads", () => {
    expect(deriveExecutionState(input)).toEqual(deriveExecutionState(structuredClone(input)));
  });
});
