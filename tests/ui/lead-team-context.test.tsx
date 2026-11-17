// @vitest-environment jsdom
import {createElement,useState} from "react";
import {afterEach,expect,it} from "vitest";
import {act,cleanup,fireEvent,waitFor} from "@testing-library/react";
import {renderSlot} from "@get-bb/plugin-sdk/testing/app";
import {LeadTeamSummary,LeadTeamDetails,LeadTeamCard,useLeadTeamVisible} from "../../src/app/lead-team-context";
import type {TeamSnapshot} from "../../src/shared/snapshot";
import type {ExperimentalThreadContextSegmentProps} from "@get-bb/plugin-sdk/app";
afterEach(cleanup);
const input={projectId:"p",threadId:"lead",environment:null};
const snapshot:TeamSnapshot={projectId:"p",projectName:"Demo",team:"main",teamTitle:"Control plane goal",teams:["main"],versioned:false,versioningBlocked:false,configSource:".bb/teams/main.yaml",configError:null,leadRole:"captain",paused:false,generatedAtMs:1,roles:[{name:"captain",title:"Captain",lead:true,inConfig:true,enabled:true,provider:"codex",model:null,threads:[{threadId:"lead",provider:"codex",status:"idle",title:"Lead",updatedAtMs:1,parentThreadId:null}],helpers:[],tasks:[]}]};
const tree=(s:TeamSnapshot=snapshot)=>({snapshots:[s],language:"en",projectName:"Demo"});
function Pane(props:typeof input){
 const visible=useLeadTeamVisible(props),[expanded,setExpanded]=useState(false);
 const all={...props,segments:[],isExpanded:expanded,onToggle:()=>setExpanded(!expanded)} as ExperimentalThreadContextSegmentProps;
 return visible?<><LeadTeamSummary {...all}/><LeadTeamDetails {...all}/></>:null;
}
it("shows the lead summary on request and navigates without sending or mutating",async()=>{
 const s=renderSlot({component:Pane},input,{rpc:{tree:()=>tree()}});
 fireEvent.click(await s.findByRole("button",{name:"Team summary"}));
 await s.findByRole("region",{name:"Team overview"});
 fireEvent.click(s.getByRole("button",{name:"Open Team"}));
 expect(s.navigateCalls).toContainEqual({method:"toPluginPanel",path:"team",options:{subPath:"p"}});
 expect(s.rpcCalls.every(c=>c.method==="tree")).toBe(true);
 fireEvent.click(s.getByRole("button",{name:"Team summary"}));expect(s.queryByRole("region",{name:"Team overview"})).toBeNull();
});
it("hides controls on executor, helper, unrelated and disabled lead threads",async()=>{
 for(const threadId of ["executor","helper","unrelated"]){
  const s=renderSlot({component:Pane},{...input,threadId},{rpc:{tree:()=>tree()}});
  await waitFor(()=>expect(s.rpcCalls.length).toBeGreaterThan(0));expect(s.queryByRole("button")).toBeNull();s.lifecycle.unmount();
 }
 const s=renderSlot({component:Pane},input,{rpc:{tree:()=>tree({...snapshot,roles:snapshot.roles.map(r=>({...r,enabled:false}))})}});
 await waitFor(()=>expect(s.rpcCalls.length).toBeGreaterThan(0));expect(s.queryByRole("button")).toBeNull();
});
it("shows ambiguity without presenting a guessed snapshot",async()=>{
 const s=renderSlot({component:Pane},input,{rpc:{tree:()=>tree({...snapshot,roles:snapshot.roles.map(r=>({...r,threads:[...r.threads,{...r.threads[0]!,threadId:"second"}]}))})}});
 fireEvent.click(await s.findByRole("button",{name:/Team summary/}));
 expect(await s.findByRole("alert")).toHaveProperty("textContent","Lead session is ambiguous. Inspect the binding in Team.");
 expect(s.queryByRole("region",{name:"Team overview"})).toBeNull();
});
it("clears stale content after failed refresh and ignores foreign realtime events",async()=>{
 let fail=false,calls=0;
 const s=renderSlot({component:Pane},input,{rpc:{tree:()=>{calls++;if(fail)throw new Error("offline");return tree();}}});
 fireEvent.click(await s.findByRole("button",{name:"Team summary"}));await s.findByRole("region",{name:"Team overview"});
 const before=calls;await s.emitRealtime("team-changed",{projectId:"foreign"});expect(calls).toBe(before);
 fail=true;await s.emitRealtime("team-changed",{projectId:"p"});
 await s.findByRole("alert");expect(s.queryByRole("region",{name:"Team overview"})).toBeNull();expect(s.rpcCalls.every(c=>c.method==="tree")).toBe(true);
});
it("ignores a late response from the previous project and thread",async()=>{
 let resolve!:(v:ReturnType<typeof tree>)=>void;
 const pending=new Promise<ReturnType<typeof tree>>(r=>{resolve=r;});
 const props={...input,segments:[],isExpanded:true,onToggle:()=>{}};
 const s=renderSlot({component:LeadTeamDetails},props,{rpc:{tree:(q:{projectId:string})=>q.projectId==="p"?pending:tree({...snapshot,projectId:"new",teamTitle:"New goal",roles:snapshot.roles.map(r=>({...r,threads:[{...r.threads[0]!,threadId:"new-lead"}]}))})}});
 s.lifecycle.rerender(createElement(LeadTeamDetails,{...props,projectId:"new",threadId:"new-lead"}));
 await s.findByText("New goal");await act(async()=>resolve(tree()));expect(s.queryByText("Control plane goal")).toBeNull();expect(s.getByText("New goal")).toBeTruthy();
});
it("renders the wide-pane card on request and keeps it out of the banner layout",async()=>{
 const s=renderSlot({component:LeadTeamCard},input,{threadContextKind:"card",rpc:{tree:()=>tree()}});
 fireEvent.click(await s.findByRole("button",{name:"Team summary"}));await s.findByRole("region",{name:"Team overview"});s.lifecycle.unmount();
 const banner=renderSlot({component:LeadTeamCard},input,{threadContextKind:"banner",rpc:{tree:()=>tree()}});
 await waitFor(()=>expect(banner.rpcCalls.length).toBeGreaterThan(0));expect(banner.queryByRole("button")).toBeNull();
});
