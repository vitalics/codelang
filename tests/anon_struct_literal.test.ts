/**
 * Tests for anonymous struct literal shorthand:
 *
 *   let p: Point = {}           ← all fields use defaults
 *   let p: Point = { x: 7 }    ← x=7, remaining fields use defaults
 *   let p: Point = { x: 3, y: 4 }  ← all fields explicit (normal struct literal with type inferred)
 *
 * The struct type is inferred from the variable's type annotation; no type name
 * is written in the literal itself.
 *
 * Fixture: anon_struct_literal.code
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function lines(fixture: string): string[] {
    return compileAndRun(fixture).stdout.trim().split('\n');
}

// =============================================================================
// 1. All fields use defaults — `let p: Point = {}`
// =============================================================================

describe('anonymous struct literal — all defaults (Point {})', () => {
    it('p1.x uses default 0', () =>
        expect(lines('anon_struct_literal.code')[0]).toBe('0'));

    it('p1.y uses default 0', () =>
        expect(lines('anon_struct_literal.code')[1]).toBe('0'));
});

// =============================================================================
// 2. One field overridden — `let p: Point = { x: 7 }`
// =============================================================================

describe('anonymous struct literal — one field overridden', () => {
    it('p2.x is the overridden value 7', () =>
        expect(lines('anon_struct_literal.code')[2]).toBe('7'));

    it('p2.y falls back to default 0', () =>
        expect(lines('anon_struct_literal.code')[3]).toBe('0'));
});

// =============================================================================
// 3. All fields explicit — `let p: Point = { x: 3, y: 4 }`
// =============================================================================

describe('anonymous struct literal — all fields explicit', () => {
    it('p3.x is 3 (explicit)', () =>
        expect(lines('anon_struct_literal.code')[4]).toBe('3'));

    it('p3.y is 4 (explicit)', () =>
        expect(lines('anon_struct_literal.code')[5]).toBe('4'));
});

// =============================================================================
// 4. Multi-field struct defaults — Config
// =============================================================================

describe('anonymous struct literal — Config with all defaults', () => {
    it('cfg.width uses default 800', () =>
        expect(lines('anon_struct_literal.code')[6]).toBe('800'));

    it('cfg.height uses default 600', () =>
        expect(lines('anon_struct_literal.code')[7]).toBe('600'));
});

// =============================================================================
// 5. String default — Named
// =============================================================================

describe('anonymous struct literal — Named with string default', () => {
    it('n.label uses default "none"', () =>
        expect(lines('anon_struct_literal.code')[8]).toBe('none'));

    it('n.value uses default 42', () =>
        expect(lines('anon_struct_literal.code')[9]).toBe('42'));
});

// =============================================================================
// 6. Overall output sanity
// =============================================================================

describe('anonymous struct literal — output and exit', () => {
    it('produces exactly 10 lines', () =>
        expect(lines('anon_struct_literal.code')).toHaveLength(10));

    it('exits with code 0', () =>
        expect(compileAndRun('anon_struct_literal.code').exitCode).toBe(0));
});

// =============================================================================
// 7. IR structure
// =============================================================================

describe('anonymous struct literal — IR structure', () => {
    it('p1 is allocated as %Point*', () => {
        const { ir } = compileToIR('anon_struct_literal.code');
        expect(ir).toMatch(/%p1 = alloca %Point\*/);
    });

    it('p2 is allocated as %Point*', () => {
        const { ir } = compileToIR('anon_struct_literal.code');
        expect(ir).toMatch(/%p2 = alloca %Point\*/);
    });

    it('default int 0 is stored as i32 0', () => {
        const { ir } = compileToIR('anon_struct_literal.code');
        expect(ir).toMatch(/store i32 0, i32\*/);
    });

    it('default string "none" appears as global constant', () => {
        const { ir } = compileToIR('anon_struct_literal.code');
        expect(ir).toMatch(/none\\00/);
    });
});
