import { describe, expect, it } from 'vitest';
import { recoveryScanner } from '../src/worker/recovery.ts';

describe('恢复通道隔离', () => {
  it('队列补投悬住期间，后续扫描仍清理 PG；同一通道不重入', async () => {
    let release!: () => void;
    let dispatches = 0; let sweeps = 0;
    const scan = recoveryScanner(async () => { dispatches++; await new Promise<void>(r => { release = r; }); }, async () => { sweeps++; });
    const first = scan();
    await new Promise<void>(resolve => setImmediate(resolve));
    await scan();
    await scan();
    expect(dispatches).toBe(1);
    expect(sweeps).toBe(3);
    release(); await first;
  });
  it('投递失败不阻止清理，下一轮仍可重试', async () => {
    let sweeps = 0; let errors = 0;
    const scan = recoveryScanner(async () => { throw new Error('queue_down'); }, async () => { sweeps++; }, () => { errors++; });
    await scan(); await scan();
    expect(sweeps).toBe(2); expect(errors).toBe(2);
  });
});
