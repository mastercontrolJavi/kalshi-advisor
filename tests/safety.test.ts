import {it,expect} from 'vitest';
import {createExecutor} from '../src/engine/executor';
import {KalshiClient} from '../src/engine/feeds/kalshi';
it('v1 rejects execution even behind an enabled flag',async()=>{expect(()=>createExecutor(true)).toThrow('v1');await expect(createExecutor().submit({ticker:'BTC',side:'yes',price:.5,contracts:1})).rejects.toThrow('advisor-only');});
it('API client rejects foreign hosts before network access',()=>{const client=new KalshiClient();expect(()=>client.get('https://example.com/',true)).toThrow();expect(()=>client.get('//example.com/',true)).toThrow();});
