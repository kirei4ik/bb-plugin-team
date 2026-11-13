import { expect, it } from "vitest";
import { executionPolicySchema, withExecutionProfile } from "./execution-policy";
import { teamConfigSchema } from "./core";
import { templateSchema } from "./templates";
const duplicate = { noAdditionalCost: true, fallbacks: [
  {provider:"pi",model:"ollama-cloud/glm-5.3",reasoningLevel:"low"},
  {provider:"pi",model:"ollama-cloud/glm-5.3",reasoningLevel:"high"},
]};
it("duplicate provider/model cannot bypass the UI through policy, YAML or template RPC schemas", () => {
  expect(executionPolicySchema.safeParse(duplicate).success).toBe(false);
  expect(teamConfigSchema.safeParse({version:1,roles:[{name:"lead",executionPolicy:duplicate}]}).success).toBe(false);
  expect(templateSchema.safeParse({id:"duplicate",title:"Duplicate",roles:[{name:"lead",executionPolicy:duplicate}]}).success).toBe(false);
});

it("a replacement prompt replaces its generated model profile rather than accumulating stale approvals",()=>{
 const old=withExecutionProfile("Original role",[{name:"dev",executionPolicy:{noAdditionalCost:true,fallbacks:[{provider:"pi",model:"old-backup"}]}}],"en");
 const fresh=withExecutionProfile(old,[{name:"dev",provider:"pi",model:"new-primary"}],"ru");
 expect(fresh).toContain("Original role");expect(fresh).toContain("new-primary");expect(fresh).not.toContain("old-backup");
 expect(fresh.match(/<!-- team-execution-profile -->/g)).toHaveLength(1);
});
