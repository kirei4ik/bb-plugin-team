import {expect,it} from "vitest";
import {resourceQueueExplanation} from "../../src/shared/resource-explanation";

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
