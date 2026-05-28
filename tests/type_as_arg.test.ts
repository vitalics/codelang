/**
 * Tests for passing types to generic functions — type_as_arg.code
 *
 * Covers every distinct mechanism for supplying a type to a function:
 *
 *   1. Inference          — T deduced from the runtime value; no <T> at call site
 *   2. Explicit type arg  — <T> pinned at call site for a user-defined generic
 *   3. Placeholder value  — caller pins type with <T>; dummy value is irrelevant
 *   4. Both params inferred — fn<A,B> with two concrete args, both A and B deduced
 *   5. Partial explicit   — first type arg given with <A>, second B still inferred
 *   6. Type forwarding    — T received by one fn, forwarded explicitly to another
 *   7. Reflect style      — generic fn introspects T via typeInfo(value)
 *
 * IR assertions verify that the compiler emits the expected monomorphized
 * specializations for each combination (e.g. @first_i32_str for A=int, B=string).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'type_as_arg.code';

let out:      string[]    = [];
let ir:       string      = '';
let exitCode: number|null = null;

beforeAll(() => {
    const r  = compileAndRun(FIXTURE);
    exitCode = r.exitCode;
    out      = r.stdout.trim().split('\n').map(l => l.trim());
    ir       = r.ir;
});

// =============================================================================
// 1. Type inference — T deduced from the runtime value
// =============================================================================

describe('type_as_arg — 1. type inference (echo<T>)', () => {

    it('echo(42) → 42  (T=int inferred from int literal)', () => {
        expect(exitCode).toBe(0);
        expect(out[0]).toBe('42');
    });

    it('echo("hello") → hello  (T=string inferred)', () => {
        expect(out[1]).toBe('hello');
    });

    it('echo(true) → true  (T=bool inferred)', () => {
        expect(out[2]).toBe('true');
    });

    it('IR: emits @echo_i32 specialization', () => {
        expect(ir).toMatch(/define .+@echo_i32\(i32/);
    });

    it('IR: emits @echo_str specialization', () => {
        expect(ir).toMatch(/define .+@echo_str\(i8\*/);
    });

    it('IR: emits @echo_bool specialization', () => {
        expect(ir).toMatch(/define .+@echo_bool\(i1/);
    });

});

// =============================================================================
// 2. Explicit type arg at the call site — same generic fn, T pinned
// =============================================================================

describe('type_as_arg — 2. explicit type arg (echo<int>, echo<string>)', () => {

    it('echo<int>(42) → 42  (explicit T=int)', () => {
        expect(out[3]).toBe('42');
    });

    it('echo<string>("hi") → hi  (explicit T=string)', () => {
        expect(out[4]).toBe('hi');
    });

    it('IR: echo_i32 is called for echo<int>(42)', () => {
        // explicit <int> and inferred int both map to the same specialization
        expect(ir).toContain('@echo_i32');
    });

    it('IR: echo_str is called for echo<string>("hi")', () => {
        expect(ir).toContain('@echo_str');
    });

});

// =============================================================================
// 3. Placeholder / type-only call
//    getTypeName<T>(dummy) — caller pins T; fn ignores the value content
// =============================================================================

describe('type_as_arg — 3. placeholder / type-only call', () => {

    it('getTypeName<int>(0) → "int"  (T pinned, dummy value irrelevant)', () => {
        expect(out[5]).toBe('int');
    });

    it('getTypeName<string>("") → "string"', () => {
        expect(out[6]).toBe('string');
    });

    it('getTypeName<bool>(false) → "bool"', () => {
        expect(out[7]).toBe('bool');
    });

    it('getTypeName(0) → "int"  (T inferred — same result as explicit)', () => {
        expect(out[8]).toBe('int');
    });

    it('getTypeName("x") → "string"  (T inferred from string literal)', () => {
        expect(out[9]).toBe('string');
    });

    it('IR: emits @getTypeName_i32 specialization', () => {
        expect(ir).toMatch(/define .+@getTypeName_i32\(i32/);
    });

    it('IR: emits @getTypeName_str specialization', () => {
        expect(ir).toMatch(/define .+@getTypeName_str\(i8\*/);
    });

    it('IR: emits @getTypeName_bool specialization', () => {
        expect(ir).toMatch(/define .+@getTypeName_bool\(i1/);
    });

});

// =============================================================================
// 4. Two type params — both A and B inferred from the arguments
// =============================================================================

describe('type_as_arg — 4. two type params, both inferred (second<A,B>)', () => {

    it('second(42, "world") → "world"  (A=int, B=string — both inferred)', () => {
        expect(out[10]).toBe('world');
    });

    it('second("hi", 99) → 99  (A=string, B=int — both inferred)', () => {
        expect(out[11]).toBe('99');
    });

    it('IR: emits @second_i32_str specialization  (A=int, B=string)', () => {
        expect(ir).toMatch(/define .+@second_i32_str\(i32.+i8\*/);
    });

    it('IR: emits @second_str_i32 specialization  (A=string, B=int)', () => {
        expect(ir).toMatch(/define .+@second_str_i32\(i8\*.+i32/);
    });

});

// =============================================================================
// 5. Partial explicit — first type arg pinned, second inferred from the value
// =============================================================================

describe('type_as_arg — 5. partial explicit type arg (first<A,B>)', () => {

    it('first<int>(10, "ignore") → 10  (A=int pinned, B=string inferred)', () => {
        expect(out[12]).toBe('10');
    });

    it('first<string>("yes", 99) → "yes"  (A=string pinned, B=int inferred)', () => {
        expect(out[13]).toBe('yes');
    });

    it('IR: emits @first_i32_str  (A=int pinned + B=string inferred)', () => {
        expect(ir).toMatch(/define .+@first_i32_str\(i32.+i8\*/);
    });

    it('IR: emits @first_str_i32  (A=string pinned + B=int inferred)', () => {
        expect(ir).toMatch(/define .+@first_str_i32\(i8\*.+i32/);
    });

    it('IR: @first_i32_str returns i32 (the pinned A=int type)', () => {
        expect(ir).toMatch(/define .+i32 @first_i32_str\(/);
    });

    it('IR: @first_str_i32 returns i8* (the pinned A=string type)', () => {
        expect(ir).toMatch(/define .+i8\* @first_str_i32\(/);
    });

});

// =============================================================================
// 6. Type forwarding — T pinned at the outer call site, forwarded to inner fn
// =============================================================================

describe('type_as_arg — 6. type forwarding (forwardToEcho<T>)', () => {

    it('forwardToEcho<int>(7) → 7  (T=int forwarded to echo<T>)', () => {
        expect(out[14]).toBe('7');
    });

    it('forwardToEcho<string>("chain") → "chain"  (T=string forwarded)', () => {
        expect(out[15]).toBe('chain');
    });

    it('IR: emits @forwardToEcho_i32 specialization', () => {
        expect(ir).toMatch(/define .+@forwardToEcho_i32\(i32/);
    });

    it('IR: emits @forwardToEcho_str specialization', () => {
        expect(ir).toMatch(/define .+@forwardToEcho_str\(i8\*/);
    });

    it('IR: forwardToEcho_i32 calls @echo_i32 (type forwarded correctly)', () => {
        // The inner body must call the matching echo specialization
        expect(ir).toMatch(/forwardToEcho_i32[\s\S]{0,200}call .+ @echo_i32/);
    });

    it('IR: forwardToEcho_str calls @echo_str (type forwarded correctly)', () => {
        expect(ir).toMatch(/forwardToEcho_str[\s\S]{0,200}call .+ @echo_str/);
    });

});

// =============================================================================
// 7. Reflect style — T inferred from a struct value; typeInfo introspects it
// =============================================================================

describe('type_as_arg — 7. reflect style (fieldCount<T>, typeInfo)', () => {

    it('fieldCount(v) → 2  (Vec2 has 2 fields, T inferred)', () => {
        expect(out[16]).toBe('2');
    });

    it('typeInfo<int>(0).name() → "int"  (explicit type arg to typeInfo)', () => {
        expect(out[17]).toBe('int');
    });

    it('typeInfo(v).name() → "Vec2"  (T inferred from Vec2 value)', () => {
        expect(out[18]).toBe('Vec2');
    });

    it('IR: emits @fieldCount_Vec2 specialization', () => {
        expect(ir).toMatch(/define .+@fieldCount_Vec2\(%Vec2\*/);
    });

    it('IR: @fieldCount_Vec2 body calls @TypeInfo_properties', () => {
        // The function body emits typeInfo metadata and then calls TypeInfo_properties.
        // Check the definition exists and the stdlib wrapper is called.
        expect(ir).toContain('@fieldCount_Vec2');
        expect(ir).toContain('call %PtrArray* @TypeInfo_properties');
    });

});

// =============================================================================
// Overall
// =============================================================================

describe('type_as_arg — overall', () => {

    it('produces exactly 19 lines of output', () => {
        expect(out).toHaveLength(19);
    });

    it('exits with code 0', () => {
        expect(exitCode).toBe(0);
    });

});
