import {useCallback,useEffect,useRef,useState} from "react";
import {useRpc,useRealtime,useBbNavigate,experimental_useThreadContextKind} from "@get-bb/plugin-sdk/app";
import type {ExperimentalThreadContextSegmentInput,ExperimentalThreadContextSegmentProps,ExperimentalThreadContextCardProps} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "../server/server";
import type {Language,TeamSnapshot} from "../shared/snapshot";
import {TeamOverview} from "./team-overview";

type View={key:string;snapshot:TeamSnapshot|null;language:Language;known:boolean;loading:boolean;ambiguous:boolean;error:boolean};
/** Each mounted pane owns its state. Late replies cannot restore another thread. */
function useLeadView({threadId,projectId}:ExperimentalThreadContextSegmentInput){
 const rpc=useRpc<typeof rpcContract>(),key=JSON.stringify([projectId,threadId]);
 const sequence=useRef(0);
 const [state,setState]=useState<View>({key,snapshot:null,language:"en",known:false,loading:true,ambiguous:false,error:false});
 const refresh=useCallback(async()=>{
  const request=++sequence.current;
  setState(previous=>({key,snapshot:null,language:previous.key===key?previous.language:"en",known:previous.key===key&&previous.known,loading:true,ambiguous:false,error:false}));
  try{
   const result=await rpc.call("tree",{projectId});if(request!==sequence.current)return;
   const matches=result.snapshots.filter(s=>s.projectId===projectId&&s.roles.some(r=>r.name===s.leadRole&&r.lead&&r.inConfig&&r.enabled&&r.threads.some(t=>t.threadId===threadId)));
   const snapshot=matches.length===1&&matches[0]!.roles.find(r=>r.name===matches[0]!.leadRole)!.threads.length===1?matches[0]!:null;
   setState({key,snapshot,language:result.language,known:matches.length>0,loading:false,ambiguous:matches.length>0&&!snapshot,error:false});
  }catch{if(request===sequence.current)setState(previous=>({...previous,key,snapshot:null,loading:false,error:true}));}
 },[rpc,key,projectId,threadId]);
 useEffect(()=>{void refresh();return()=>{sequence.current++;};},[refresh]);
 useRealtime("team-changed",payload=>{if((payload as {projectId?:string}|null)?.projectId===projectId)void refresh();});
 return {view:state.key===key?state:null,refresh};
}
export function useLeadTeamVisible(input:ExperimentalThreadContextSegmentInput){
 const {view}=useLeadView(input),kind=experimental_useThreadContextKind();
 return kind!=="card"&&!!view?.known;
}
function OpenTeam({projectId,ru}:{projectId:string;ru:boolean}){
 const navigate=useBbNavigate();
 return <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={()=>navigate.toPluginPanel("team",{subPath:encodeURIComponent(projectId)})}>{ru?"Открыть Team":"Open Team"}</button>;
}
export function LeadTeamSummary(props:ExperimentalThreadContextSegmentProps){
 const {view}=useLeadView(props);if(!view?.known)return null;
 const ru=view.language==="ru";
 return <button type="button" aria-expanded={props.isExpanded} onClick={props.onToggle} className="text-xs">{ru?"Сводка Team":"Team summary"}{view.loading?" …":view.error||view.ambiguous?" ⚠":""}</button>;
}
function LeadContent({input}:{input:ExperimentalThreadContextSegmentInput}){
 const {view,refresh}=useLeadView(input);if(!view||!view.known&&!view.error&&!view.loading)return null;
 const ru=view.language==="ru";
 return <section aria-label={ru?"Сводка руководителя":"Lead team summary"} className="flex flex-col gap-2 p-2">
  <div className="flex flex-wrap gap-2"><OpenTeam projectId={input.projectId} ru={ru}/><button type="button" disabled={view.loading} className="text-xs" onClick={()=>void refresh()}>{ru?"Обновить сводку":"Refresh summary"}</button></div>
  {view.loading?<p>{ru?"Обновляется…":"Refreshing…"}</p>:view.error?<p role="alert">{ru?"Сводка недоступна. Проверьте подключение и обновите данные.":"Summary unavailable. Check the connection and refresh."}</p>:view.ambiguous?<p role="alert">{ru?"Сессия руководителя неоднозначна. Проверьте привязку в Team.":"Lead session is ambiguous. Inspect the binding in Team."}</p>:view.snapshot?<><TeamOverview snapshot={view.snapshot} language={view.language}/><p className="text-xs text-muted-foreground">{ru?"Данные трекера и контроллера на":"Tracker and controller snapshot at"} {new Date(view.snapshot.generatedAtMs).toLocaleString()}</p></>:null}
 </section>;
}
export function LeadTeamDetails(props:ExperimentalThreadContextSegmentProps){
 return props.isExpanded?<LeadContent input={props}/>:null;
}
export function LeadTeamCard(props:ExperimentalThreadContextCardProps){
 const {view}=useLeadView(props),kind=experimental_useThreadContextKind();
 const [expanded,setExpanded]=useState(false);
 if(kind!=="card"||!view?.known)return null;
 const ru=view.language==="ru";
 return <div><button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{ru?"Сводка Team":"Team summary"}</button> <OpenTeam projectId={props.projectId} ru={ru}/>{expanded&&<LeadContent key={props.threadId} input={props}/>}</div>;
}
