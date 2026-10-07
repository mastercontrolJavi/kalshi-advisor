import {it,expect} from 'vitest';
import {authorized} from '../src/engine/auth';
it('HTTP and websocket share fail-closed basic authentication',()=>{process.env.DASHBOARD_USER='user';process.env.DASHBOARD_PASSWORD='secret';expect(authorized(undefined)).toBe(false);expect(authorized('Basic '+Buffer.from('user:wrong').toString('base64'))).toBe(false);expect(authorized('Basic '+Buffer.from('user:secret').toString('base64'))).toBe(true);delete process.env.DASHBOARD_PASSWORD;expect(authorized('Basic '+Buffer.from('user:secret').toString('base64'))).toBe(false);});
