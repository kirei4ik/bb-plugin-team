import {expect,it} from "vitest";
import {boundedDispatchDecision,resourceQueueExplanation} from "../../src/shared/resource-explanation";

it("explains the exact task allowance in the queue without calling it provider quota",()=>{
 const text=resourceQueueExplanation("Team resources: Task attempt limit reached (task:konspektum-apg: 29/29); a new card or session cannot reset it","ru");
 expect(text).toContain("29 из 29");expect(text).toContain("konspektum-apg");expect(text).toContain("возвратов");expect(text).toContain("не квота провайдера");expect(text).toContain("повторно отправлять его не нужно");
});
it("distinguishes a team-wide limit from the lead task allowance",()=>{
 expect(resourceQueueExplanation("Team resources: Team start limit reached (100)","ru")).toContain("общий лимит команды: 100 запусков");
 expect(resourceQueueExplanation("Team resources: Team start limit reached (100)","en")).toContain("team-wide limit of 100 starts");
});
it("does not guess the cause of unrelated guards",()=>{
 expect(resourceQueueExplanation("Delivery is uncertain; inspect the queue","ru")).toBe("Delivery is uncertain; inspect the queue");
});


it("keeps localized resource waits valid at the real BB hook boundary",()=>{
 for(const lang of ["en","ru"] as const){
  const reason=resourceQueueExplanation("Team resources: Task attempt limit reached (task:scope: 29/29)",lang);
  const result=boundedDispatchDecision({action:"wait",reason,sendAt:123});
  expect(result).toMatchObject({action:"wait",sendAt:123});
  expect(result.action==="wait"&&result.reason.length).toBeLessThanOrEqual(200);
 }
 const reason=`Epic budget exhausted (${"epic-".repeat(40)}: 8/8); inspect Team`;
 const decision=boundedDispatchDecision({action:"wait",reason});
 expect(decision.action==="wait"&&decision.reason).toMatch(/^Epic budget exhausted/);
 expect(decision.action==="wait"&&decision.reason.length).toBe(200);
 expect(boundedDispatchDecision({action:"proceed"})).toEqual({action:"proceed"});
 expect(boundedDispatchDecision({action:"reject",message:"Explain the refusal"})).toEqual({action:"reject",message:"Explain the refusal"});
});
