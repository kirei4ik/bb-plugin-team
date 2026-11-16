import {expect,it} from "vitest";
import {executionDiagnostic} from "../../src/shared/execution-diagnostic";
import type {TeamTask,RoleExecutionState} from "../../src/shared/snapshot";
const task:TeamTask={id:"t1",role:"dev",title:"Work",status:"in-progress",note:null,createdAtMs:1,updatedAtMs:2};
const state:RoleExecutionState={kind:"error",taskId:"t1",errorCode:"resource_hold",safeAction:null,atMs:5};
it("projects execution separately from the tracker and keeps queued tasks waiting",()=>{
 expect(executionDiagnostic(task,state)).toMatchObject({status:"resource",source:"resources",atMs:5});
 expect(task.status).toBe("in-progress");
 expect(executionDiagnostic({...task,id:"t2",status:"todo"},state)).toMatchObject({status:"waiting",source:"tracker"});
});
it("keeps review and acceptance independent of a session hold",()=>{
 expect(executionDiagnostic({...task,status:"review"},state)).toMatchObject({status:"review"});
 expect(executionDiagnostic({...task,status:"done"},state)).toMatchObject({status:"done",savedResult:"accepted"});
 expect(executionDiagnostic({...task,status:"dropped"},state)).toMatchObject({status:"cancelled"});
});
