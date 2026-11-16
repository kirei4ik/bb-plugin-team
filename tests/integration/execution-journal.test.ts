import {describe,expect,it} from "vitest";
import {createFakePluginHost} from "@get-bb/plugin-sdk/testing";
import {ExecutionJournal,JOURNAL_MAX_EVENTS} from "../../src/server/execution-journal";
import {executionEventSchema} from "../../src/shared/execution-event";

describe("durable technical execution journal",()=>{
 it("deduplicates replay after reconstruction and keeps operation transitions separate",async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:"journal"});
  try{
   const event={projectId:"p",team:"main",taskId:"task",role:"dev",threadId:"thread",operationId:"op",eventType:"attempt" as const,nextState:"reserved",reasonCode:"attempt_reserved",provider:"pi",model:"free"};
   const journal=new ExecutionJournal(bb,()=>100);
   const callerContext={...event,prompt:"private prompt",apiKey:"secret-test-marker",hostId:"host"};
   journal.record(callerContext);journal.record({...event,nextState:"running",reasonCode:"attempt_running"});
   new ExecutionJournal(bb,()=>100).record(event);
   const rows=journal.list("p","main");
   expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({previousState:"reserved",nextState:"running"});
   for(const row of rows)expect(executionEventSchema.safeParse(row).success).toBe(true);
   expect(JSON.stringify(rows)).not.toContain("secret-test-marker");expect(JSON.stringify(rows)).not.toContain("private prompt");
   expect(journal.list("p","other")).toEqual([]);
   expect(journal.list("p","main","lead")).toEqual([]);
  }finally{await harness.lifecycle.dispose();}
 });
 it("bounds retention and total rows without persisting raw fields",async()=>{
  const {bb,harness}=createFakePluginHost({pluginId:"journal"});
  try{
   let now=1;const journal=new ExecutionJournal(bb,()=>now);
   const event={projectId:"p",team:"main",taskId:null,role:"dev",threadId:null,eventType:"handoff" as const,nextState:"complete",reasonCode:"handoff_complete",provider:null,model:null};
   journal.record({...event,operationId:"old"});now=31*86400000;
   // Use the same transaction boundary as resource accounting, avoiding 6000
   // unrelated fsyncs in fixture setup on a busy host.
   bb.storage.database().transaction(()=>{for(let i=0;i<=JOURNAL_MAX_EVENTS;i++)journal.record({...event,operationId:String(i)});})();
   const rows=journal.list("p","main");expect(rows).toHaveLength(JOURNAL_MAX_EVENTS);expect(rows.some(e=>e.operationId==="old")).toBe(false);
   expect(Object.keys(rows[0]!)).not.toContain("prompt");
  }finally{await harness.lifecycle.dispose();}
 },15000);
});
