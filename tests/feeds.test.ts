import {it,expect} from 'vitest';
import {median,healthy} from '../src/engine/feeds/proxy';
it('median robust to outlier and averages even population',()=>{expect(median([100,101,1000])).toBe(101);expect(median([100,102])).toBe(101);expect(median([])).toBeNull();});
it('stale/disconnected venues dropped',()=>{const v={name:'x',mid:100,spread:1,updated:1000,alive:1000,lag:0,status:'connected'};expect(healthy(v,3001)).toBe(false);expect(healthy(v,2999)).toBe(true);expect(healthy({...v,status:'disconnected'},1500)).toBe(false);expect(healthy({...v,mid:null},1500)).toBe(false);});
it('a quiet quote on a live link stays healthy; a dead link does not',()=>{const v={name:'x',mid:100,spread:1,updated:1000,alive:11000,lag:0,status:'connected'};expect(healthy(v,12000)).toBe(true);expect(healthy(v,16500)).toBe(false);expect(healthy({...v,alive:1000},3500)).toBe(false);});
