import {it,expect} from 'vitest';
import {Orderbook} from '../src/engine/feeds/orderbook';
import {generateKeyPairSync,verify,constants} from 'node:crypto';
import {signedHeaders} from '../src/engine/feeds/kalshi';
it('applies sequenced deltas and rejects gaps',()=>{const b=new Orderbook();b.snapshot([['.4','20']],[['.5','30']],10);expect(b.delta(11,'yes',.4,-5)).toBe(true);expect(b.view().yes[0]).toEqual([.4,15]);expect(b.view().yesAsk).toBe(.5);expect(b.delta(13,'yes',.4,5)).toBe(false);expect(b.valid).toBe(false);});
it('REST cannot seed WS sequence and negative depth invalidates',()=>{const b=new Orderbook();b.snapshot([['.4','1']],[],null,'rest');expect(b.delta(1,'yes',.4,2)).toBe(false);b.snapshot([['.4','1']],[],10);expect(b.delta(11,'yes',.4,-2)).toBe(false);});
it('signature strips query and uses digest length RSA PSS',()=>{const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const h=signedHeaders(privateKey,'id','/trade-api/v2/markets?limit=1',1000);expect(verify('sha256',Buffer.from('1000GET/trade-api/v2/markets'),{key:publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(h['KALSHI-ACCESS-SIGNATURE'],'base64'))).toBe(true);});
