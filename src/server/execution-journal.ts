import {createHash} from "node:crypto";
import type {BbPluginApi} from "@get-bb/plugin-sdk";
import type {ExecutionEvent} from "../shared/execution-event";
import {STORAGE_MIGRATIONS} from "./storage-migrations";

export const JOURNAL_RETENTION_DAYS = 30;
export const JOURNAL_MAX_EVENTS = 2000;
const instances = new WeakMap<BbPluginApi, ExecutionJournal>();
export function executionJournal(bb: BbPluginApi): ExecutionJournal {
  let journal = instances.get(bb);
  if (!journal) {journal = new ExecutionJournal(bb); instances.set(bb, journal);}
  return journal;
}

/** Technical transitions only. No raw errors, prompts, credentials or task text. */
export class ExecutionJournal {
  private db: ReturnType<BbPluginApi["storage"]["database"]>;
  constructor(bb: BbPluginApi, private now = Date.now) {
    this.db = bb.storage.database();
    bb.storage.migrate(this.db, STORAGE_MIGRATIONS);
  }
  record(input: Omit<ExecutionEvent, "message" | "previousState" | "timestamp"> & {timestamp?: number}): void {
    const scope = JSON.stringify([input.projectId, input.team]);
    const key = createHash("sha256").update(JSON.stringify([scope, input.eventType, input.operationId, input.nextState])).digest("hex");
    if (this.db.prepare("SELECT id FROM team_execution_events WHERE id=?").get(key)) return;
    const operation = JSON.stringify([input.eventType, input.operationId]);
    const previous = this.db.prepare("SELECT data FROM team_execution_events WHERE scope=? AND operation=? ORDER BY rowid DESC LIMIT 1").get(scope, operation) as {data: string} | undefined;
    const prior = previous ? JSON.parse(previous.data) as ExecutionEvent : null;
    const event: ExecutionEvent = {timestamp:input.timestamp??this.now(),projectId:input.projectId,team:input.team,taskId:input.taskId,role:input.role,
      threadId:input.threadId,operationId:input.operationId,eventType:input.eventType,previousState:prior?.nextState??null,
      nextState:input.nextState,reasonCode:input.reasonCode,provider:input.provider,model:input.model,message:`${input.eventType}: ${input.nextState}`};
    this.db.prepare("INSERT OR IGNORE INTO team_execution_events(id,scope,operation,timestamp,data) VALUES(?,?,?,?,?)").run(key, scope, operation, event.timestamp, JSON.stringify(event));
    this.db.prepare("DELETE FROM team_execution_events WHERE timestamp < ?").run(this.now() - JOURNAL_RETENTION_DAYS * 86400000);
    this.db.prepare("DELETE FROM team_execution_events WHERE scope=? AND rowid NOT IN (SELECT rowid FROM team_execution_events WHERE scope=? ORDER BY rowid DESC LIMIT ?)").run(scope, scope, JOURNAL_MAX_EVENTS);
  }
  list(projectId: string, team: string, role?: string): ExecutionEvent[] {
    const rows = this.db.prepare("SELECT data FROM team_execution_events WHERE scope=? AND timestamp>=? ORDER BY rowid DESC LIMIT ?").all(JSON.stringify([projectId, team]), this.now() - JOURNAL_RETENTION_DAYS * 86400000, JOURNAL_MAX_EVENTS) as Array<{data: string}>;
    return rows.map(row => JSON.parse(row.data) as ExecutionEvent).filter(event => role === undefined || event.role === role);
  }
}
