export interface OrderIdea {ticker:string;side:'yes'|'no';price:number;contracts:number}
export interface Executor {submit(idea:OrderIdea):Promise<void>}
export class DisabledExecutor implements Executor {
  async submit(_idea:OrderIdea):Promise<void>{throw new Error('v1 is advisor-only; order execution is unavailable');}
}
export function createExecutor(enabled=false):Executor {if(enabled)throw new Error('ENABLE_EXECUTOR cannot be enabled in v1');return new DisabledExecutor();}
