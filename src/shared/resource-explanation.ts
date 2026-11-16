import type {ResourceSummary} from "../server/resource-control";
import type {Language} from "./snapshot";

/** Explain known Team admission holds without changing their accounting or codes. */
export function resourceQueueExplanation(reason:string,language:Language):string {
  const task=reason.match(/Task attempt limit reached \(task:([^:]+): (\d+)\/(\d+)\)/);
  const team=reason.match(/Team start limit reached \((\d+)\)/);
  const time=reason.match(/Team time limit reached \((\d+) minutes\)/);
  const tokens=reason.match(/Reported cumulative token limit reached \((\d+)\)/);
  const ru=language==="ru";
  const cause=task?(ru?`Для задачи ${task[1]} использовано ${task[2]} из ${task[3]} разрешённых запусков и возвратов на доработку.`:`Task ${task[1]} used ${task[2]} of ${task[3]} allowed starts and rework returns.`):
    team?(ru?`Достигнут общий лимит команды: ${team[1]} запусков.`:`The team-wide limit of ${team[1]} starts was reached.`):
    time?(ru?`Достигнут лимит времени Team: ${time[1]} минут с начала работы.`:`The Team time limit of ${time[1]} minutes since work began was reached.`):
    tokens?(ru?`Достигнут лимит Team по сообщённым токенам: ${tokens[1]}.`:`The Team reported-token limit of ${tokens[1]} was reached.`):null;
  if(!cause)return reason;
  return ru?`Team удерживает сообщение в очереди. ${cause} Это внутреннее ограничение плагина, не квота провайдера. Откройте Team → текущий проект, чтобы проверить расход и решить, продолжать ли работу. Сообщение уже сохранено; повторно отправлять его не нужно.`:
    `Team is holding this message in the queue. ${cause} This is an internal plugin limit, not provider quota. Open Team → this project to review usage and decide whether to continue. The message is saved; do not send it again.`;
}

/** Global resource guards plus only the selected package's allowance. */
export function packageResourceBlock(summary:ResourceSummary,taskId:string|number|null|undefined):string|null {
 return summary.blocked??(taskId==null?null:summary.taskBlocks?.[`task:${taskId}`]??null);
}
