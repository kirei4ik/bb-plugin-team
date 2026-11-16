import {expect,it} from "vitest";
import {createFakePluginHost,makeTurnFailedEvent} from "@get-bb/plugin-sdk/testing";
import {verifyQuotaBoundary,type WorkCheckpoint} from "../../src/server/checkpoint";

it.each(["turn/started","turn/completed"])("refuses unrelated post-checkpoint %s even without a completed success",async(type)=>{
 const {bb,harness}=createFakePluginHost({pluginId:"boundary",sdk:{threads:{events:{list:async()=>[
  {id:"other",seq:3,createdAt:1200,type,scope:{kind:"turn",turnId:"other"},data:{status:"interrupted"}},
  {id:"request",seq:2,createdAt:1100,type:"client/turn/requested",scope:{kind:"thread"},data:{requestId:"request"}},
 ] as never}}}});
 try{await expect(verifyQuotaBoundary(bb,makeTurnFailedEvent({threadId:"thread",requestId:"request",turnId:"refused",inputAccepted:false}),{threadId:"thread",atMs:1000} as WorkCheckpoint)).rejects.toMatchObject({code:"checkpoint_history_stale"});}
 finally{await harness.lifecycle.dispose();}
});

it("refuses another session's checkpoint before reading history",async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:"boundary"});
 try{await expect(verifyQuotaBoundary(bb,makeTurnFailedEvent({threadId:"thread",inputAccepted:false}),{threadId:"old",atMs:1000} as WorkCheckpoint)).rejects.toMatchObject({code:"checkpoint_session_mismatch"});expect(harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(0);}
 finally{await harness.lifecycle.dispose();}
});
