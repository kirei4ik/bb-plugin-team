import {describe, it, expect} from "vitest";
import {createFakePluginHost, makeThreadResponse} from "@get-bb/plugin-sdk/testing";
import {inspectBindings, repairBinding} from "../../src/server/bindings";
import {scanTeamThreads} from "../../src/server/core";
import {activeSessionKey, replacementKey} from "../../src/server/sessions";

function setup(options: {count?:number; archived?:boolean; differentEnvironment?:boolean; held?:boolean; helper?:boolean} = {}) {
  const old = makeThreadResponse({id:"old", projectId:"p", environmentId:"env", archivedAt:options.archived === false ? null : 1});
  const live = Array.from({length: options.count ?? 1}, (_,i) => makeThreadResponse({id:`new${i}`,projectId:"p",environmentId:options.differentEnvironment?"other":"env"}));
  const {bb,harness} = createFakePluginHost({pluginId:"team",sdk:{threads:{
    list:async()=>options.archived === false ? [...live,old] : live,
    get:async()=>old,
    experimental_listPluginMetadata:async({threadIds}:{threadIds:string[]})=>({threads:threadIds.map(threadId=>({threadId,metadata:options.helper?{teamName:"main",teamHelperOf:"junior"}:{teamName:"main",teamRole:"junior",...(options.held?{teamReplacement:true}:{})}}))}),
  }}});
  return {bb,harness};
}

describe("binding recovery",()=>{
  it("reveals a hidden unique session, repairs without spawn/send/recheck, keeps paused",async()=>{
    const {bb,harness}=setup();
    await bb.storage.kv.set(activeSessionKey("p","main","junior"),"old");
    expect((await scanTeamThreads(bb,"p")).rows).toEqual([]);
    const issues=await inspectBindings(bb,"p","main",["junior"]);
    expect(issues[0]?.state).toBe("repairable");
    await repairBinding(bb,"p","main",issues[0]!);
    expect(await bb.storage.kv.get("role-paused:p:main:junior")).toBe(true);
    expect((await scanTeamThreads(bb,"p")).rows[0]?.threadId).toBe("new0");
    expect(await inspectBindings(bb,"p","main",["junior"])).toEqual([]);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it.each([{count:0,state:"missing"},{count:2,state:"ambiguous"},{differentEnvironment:true,state:"blocked"},{helper:true,state:"missing"},{held:true,state:"blocked"}])("does not guess %j",async({state,...options})=>{
    const {bb}=setup(options);
    await bb.storage.kv.set(activeSessionKey("p","main","junior"),"old");
    const issue=(await inspectBindings(bb,"p","main",["junior"]))[0]!;
    expect(issue.state).toBe(state);
    await expect(repairBinding(bb,"p","main",issue)).rejects.toThrow();
    expect(await bb.storage.kv.get(activeSessionKey("p","main","junior"))).toBe("old");
  });
  it("never replaces a live canonical or an unfinished intent",async()=>{
    const {bb}=setup({archived:false});
    await bb.storage.kv.set(activeSessionKey("p","main","junior"),"old");
    expect(await inspectBindings(bb,"p","main",["junior"])).toEqual([]);
    const h=setup();
    await h.bb.storage.kv.set(activeSessionKey("p","main","junior"),"old");
    await h.bb.storage.kv.set(replacementKey("p","main","junior"),{oldThreadId:"old",newThreadId:"new0",environmentId:"env",keep:false,stage:"switching",delivery:"pending",reparented:0,resumed:false,startedAt:1});
    expect((await inspectBindings(h.bb,"p","main",["junior"]))[0]?.state).toBe("blocked");
  });
  it("rejects stale UI candidate instead of changing pointer",async()=>{
    const {bb}=setup();await bb.storage.kv.set(activeSessionKey("p","main","junior"),"old");
    const issue=(await inspectBindings(bb,"p","main",["junior"]))[0]!;
    await expect(repairBinding(bb,"p","main",{...issue,candidates:["not-new0"]})).rejects.toThrow();
    expect(await bb.storage.kv.get(activeSessionKey("p","main","junior"))).toBe("old");
  });
});
