/**
 * Async stdlib tests — pthreads-based concurrency primitives.
 *
 * Covers:
 *   - Task spawn and wait (async_spawn.code)
 *   - Sleep (async_sleep.code)
 *   - Context key-value propagation (async_context.code)
 *   - Priority scheduler — all tasks complete before waitAll returns
 *     (async_scheduler.code)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

// ── Shared fixture results ────────────────────────────────────────────────────

interface FixtureResult {
    exitCode: number | null;
    lines:    string[];
}

let spawn:     FixtureResult = { exitCode: null, lines: [] };
let sleep:     FixtureResult = { exitCode: null, lines: [] };
let context:   FixtureResult = { exitCode: null, lines: [] };
let scheduler: FixtureResult = { exitCode: null, lines: [] };
let priority:  FixtureResult = { exitCode: null, lines: [] };

beforeAll(() => {
    const r1  = compileAndRun('async_spawn.code');
    spawn     = { exitCode: r1.exitCode, lines: r1.stdout.trim().split('\n') };

    const r2  = compileAndRun('async_sleep.code');
    sleep     = { exitCode: r2.exitCode, lines: r2.stdout.trim().split('\n') };

    const r3  = compileAndRun('async_context.code');
    context   = { exitCode: r3.exitCode, lines: r3.stdout.trim().split('\n') };

    const r4  = compileAndRun('async_scheduler.code');
    scheduler = { exitCode: r4.exitCode, lines: r4.stdout.trim().split('\n') };

    const r5  = compileAndRun('async_priority.code');
    priority  = { exitCode: r5.exitCode, lines: r5.stdout.trim().split('\n') };
}, 300_000);

// ── async_spawn ───────────────────────────────────────────────────────────────

describe('async_spawn — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(spawn.exitCode).toBe(0);
    });
    it('produces exactly 3 lines of output', () => {
        expect(spawn.lines).toHaveLength(3);
    });
});

describe('async_spawn — ordering', () => {
    it('prints "before" first', () => {
        expect(spawn.lines[0]).toBe('before');
    });
    it('prints "in task" in the middle', () => {
        expect(spawn.lines[1]).toBe('in task');
    });
    it('prints "after" last (wait() blocks until task finishes)', () => {
        expect(spawn.lines[2]).toBe('after');
    });
});

// ── async_sleep ───────────────────────────────────────────────────────────────

describe('async_sleep — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(sleep.exitCode).toBe(0);
    });
    it('produces exactly 3 lines of output', () => {
        expect(sleep.lines).toHaveLength(3);
    });
});

describe('async_sleep — output', () => {
    it('prints "before" first', () => {
        expect(sleep.lines[0]).toBe('before');
    });
    it('prints "after" second (sleep 50 ms completes)', () => {
        expect(sleep.lines[1]).toBe('after');
    });
    it('prints "ok" last', () => {
        expect(sleep.lines[2]).toBe('ok');
    });
});

// ── async_context ─────────────────────────────────────────────────────────────

describe('async_context — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(context.exitCode).toBe(0);
    });
    it('produces exactly 6 lines of output', () => {
        expect(context.lines).toHaveLength(6);
    });
});

describe('async_context — key lookup', () => {
    it('ctx.get("requestId") returns "req-1"', () => {
        expect(context.lines[0]).toBe('req-1');
    });
    it('ctx.get("user") returns "alice"', () => {
        expect(context.lines[1]).toBe('alice');
    });
    it('ctx.get("missing") returns "" (empty string)', () => {
        expect(context.lines[2]).toBe('');
    });
});

describe('async_context — spawned task propagation', () => {
    it('spawned task reads ctx.get("requestId") = "req-1"', () => {
        expect(context.lines[3]).toBe('req-1');
    });
});

describe('async_context — child context inheritance', () => {
    it('child.get("role") returns "child-value"', () => {
        expect(context.lines[4]).toBe('child-value');
    });
    it('child.get("requestId") inherits "req-1" from parent', () => {
        expect(context.lines[5]).toBe('req-1');
    });
});

// ── async_scheduler ───────────────────────────────────────────────────────────

describe('async_scheduler — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(scheduler.exitCode).toBe(0);
    });
    it('produces exactly 7 lines of output', () => {
        expect(scheduler.lines).toHaveLength(7);
    });
});

describe('async_scheduler — ordering', () => {
    it('prints "start" first', () => {
        expect(scheduler.lines[0]).toBe('start');
    });
    it('prints "done" last (waitAll blocks until all tasks complete)', () => {
        expect(scheduler.lines[6]).toBe('done');
    });
    it('all five priority tasks execute (p0–p4 in any order)', () => {
        const middle = scheduler.lines.slice(1, 6);
        expect(middle).toContain('p0');
        expect(middle).toContain('p1');
        expect(middle).toContain('p2');
        expect(middle).toContain('p3');
        expect(middle).toContain('p4');
    });
});

// ── Priority enum (scheduler integration) ────────────────────────────────────

describe('Priority enum — scheduler integration', () => {
    // async_scheduler.code uses Priority::Highest … Lowest with postTask.
    // The presence of p0–p4 in the output verifies all enum variants compile
    // and are accepted by postTask(f: fn(): void, priority: Priority).
    it('Priority::Highest dispatches a task (p0 appears in output)', () => {
        expect(scheduler.lines).toContain('p0');
    });
    it('Priority::High dispatches a task (p1 appears in output)', () => {
        expect(scheduler.lines).toContain('p1');
    });
    it('Priority::Medium dispatches a task (p2 appears in output)', () => {
        expect(scheduler.lines).toContain('p2');
    });
    it('Priority::Low dispatches a task (p3 appears in output)', () => {
        expect(scheduler.lines).toContain('p3');
    });
    it('Priority::Lowest dispatches a task (p4 appears in output)', () => {
        expect(scheduler.lines).toContain('p4');
    });
});

// ── async_priority (Priority.toNumber values) ─────────────────────────────────

describe('async_priority — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(priority.exitCode).toBe(0);
    });
    it('produces exactly 5 lines of output', () => {
        expect(priority.lines).toHaveLength(5);
    });
});

describe('Priority.toNumber() — exact values', () => {
    it('Priority::Highest.toNumber() === 0', () => {
        expect(parseInt(priority.lines[0])).toBe(0);
    });
    it('Priority::High.toNumber() === 1', () => {
        expect(parseInt(priority.lines[1])).toBe(1);
    });
    it('Priority::Medium.toNumber() === 2', () => {
        expect(parseInt(priority.lines[2])).toBe(2);
    });
    it('Priority::Low.toNumber() === 3', () => {
        expect(parseInt(priority.lines[3])).toBe(3);
    });
    it('Priority::Lowest.toNumber() === 4', () => {
        expect(parseInt(priority.lines[4])).toBe(4);
    });
    it('values are strictly ordered: Highest < High < Medium < Low < Lowest', () => {
        const nums = priority.lines.map(l => parseInt(l));
        expect(nums[0]).toBeLessThan(nums[1]);
        expect(nums[1]).toBeLessThan(nums[2]);
        expect(nums[2]).toBeLessThan(nums[3]);
        expect(nums[3]).toBeLessThan(nums[4]);
    });
});
