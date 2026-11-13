import { describe, expect, it } from "vitest";
import { acceptanceGate, type AcceptanceGateInput, type TaskReviewRecord } from "./review";
const submission = {id:"sub_existing",version:1 as const,result:"Result",checks:[{what:"Read output",result:"matches"}],submittedBy:"dev",atMs:1};
function gate(patch: Partial<AcceptanceGateInput> = {}) {
  return acceptanceGate({caller:"lead",callerRole:"lead",from:"in-progress",to:undefined,record:undefined,submission:undefined,acceptReason:undefined,returnReason:undefined,stamp:{id:"sub_new",submittedBy:"lead"},nowMs:2,expectedSubmissionId:undefined,...patch});
}
describe("parent review regressions", () => {
  it("lead cannot pre-record acceptance without a report then reuse it to close", () => {
    expect(gate({acceptReason:"Looks done"})).toEqual({ok:false,code:"review_submission_required"});
  });
  it("an earlier reportless lead decision never grants acceptance", () => {
    const record: TaskReviewRecord = {version:1,decisions:[{decision:"accept",reason:"Old reportless acceptance",decidedBy:"lead",basis:"manual",atMs:1}]};
    expect(gate({record,to:"done"}).ok).toBe(false);
  });
  it("invalid incoming report must not silently reuse an older valid report", () => {
    const record: TaskReviewRecord = {version:1,submission,decisions:[]};
    for (const to of ["review","done"] as const) {
      expect(gate({record,to,submission:{result:"missing checks"},acceptReason:"Accept"})).toEqual({ok:false,code:"review_submission_required"});
    }
  });
});

it("rejects stale no-report views and requires the lead to name the viewed report",()=>{
 const record:TaskReviewRecord={version:1,submission,decisions:[]};
 expect(gate({record,to:"done",acceptReason:"Checked",expectedSubmissionId:null})).toEqual({ok:false,code:"submission_conflict"});
 expect(gate({record,to:"done",acceptReason:"Checked"})).toEqual({ok:false,code:"submission_conflict"});
 expect(gate({record,to:"done",acceptReason:"Checked",expectedSubmissionId:submission.id}).ok).toBe(true);
});
