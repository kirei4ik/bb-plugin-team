import type {QuotaSource} from "./openrouter-usage";
export function QuotaSourceEditor({value,onChange,language,readOnly,name}:{value?:QuotaSource;onChange:(v:QuotaSource|undefined)=>void;language:"ru"|"en";readOnly?:boolean;name?:string}){
 const ru=language==="ru";
 return <fieldset className="flex flex-col gap-2 rounded border border-border p-2 text-xs" disabled={readOnly}>
  <legend>{ru?"Источник квоты":"Quota source"}{name?` · ${name}`:""}</legend>
  <label>{ru?"Сервис":"Service"}<select disabled={readOnly} value={value?.service??"auto"} onChange={e=>onChange(e.target.value==="auto"?undefined:{service:e.target.value as QuotaSource["service"]})}>
   <option value="auto">{ru?"Определять автоматически":"Detect automatically"}</option>
   <option value="openrouter">OpenRouter</option><option value="ollama-cloud">Ollama Cloud · Pi</option>
  </select></label>
  {value?.service==="openrouter"&&<>
   <label>{ru?"Переменная действующего ключа на рабочем хосте (не сам ключ)":"Execution-host variable holding the actual key (not the key itself)"}<input disabled={readOnly} value={value.credentialEnv??""} placeholder="OPENROUTER_API_KEY" pattern="[A-Za-z_][A-Za-z0-9_]*" onChange={e=>onChange({service:value.service,...(e.target.value?{credentialEnv:e.target.value}:{})})}/></label>
   <p>{ru?"Оставьте пустым для штатного профиля Pi или Qwen Code. Для другой обёртки укажите имя переменной с тем ключом, которым она работает. Настройка только выбирает источник проверки и не меняет подключение агента.":"Leave empty for the standard Pi or Qwen Code profile. Other launchers need the variable containing their actual key. This selects the quota check source; it does not change the agent connection."}</p>
  </>}
 </fieldset>;
}
