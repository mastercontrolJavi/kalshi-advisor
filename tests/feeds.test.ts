import {it,expect} from 'vitest';
import {median,healthy} from '../src/engine/feeds/proxy';
it('median robust to outlier and averages even population',()=>{expect(median([100,101,1000])).toBe(101);expect(median([100,102])).toBe(101);expect(median([])).toBeNull();});
it('stale/disconnected venues dropped',()=>{const v={name:'x',mid:100,spread:1,updated:1000,lag:0,status:'connected'};expect(healthy(v,3001)).toBe(false);expect(healthy(v,2999)).toBe(true);expect(healthy({...v,status:'disconnected'},1001)).toBe(false);});
