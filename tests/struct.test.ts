/**
 * Tests for struct type declarations, field access, and inline methods.
 *
 * Covers:
 *  1. Struct type layout in LLVM IR
 *  2. Auto-generated constructor emission
 *  3. Field access on variables (p.x)
 *  4. self.field access inside inline struct methods
 *  5. Method dispatch via extension table
 *  6. String-field structs and string concatenation in method bodies
 *  7. Runtime correctness (compileAndRun)
 *  8. Protocol-bound syntax (T extends Proto) is parsed and works
 *
 * All runtime tests use `compileAndRun`; IR structure tests use `compileToIR`.
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1 + 2. Struct type layout and constructor
// =============================================================================

describe('Struct — type layout and constructor (IR)', () => {

    it('emits %Point = type { i32, i32 }', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toContain('%Point = type { i32, i32 }');
    });

    it('emits @Point_new with correct signature', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toMatch(/define private %Point\* @Point_new\(i32 %arg\.0, i32 %arg\.1\)/);
    });

    it('constructor uses malloc + sizeof trick', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toMatch(/getelementptr %Point, %Point\* null, i32 1/);
        expect(ir).toMatch(/call i8\* @malloc\(i64 %sizeof\)/);
        expect(ir).toMatch(/bitcast i8\* %raw to %Point\*/);
    });

    it('constructor stores all fields', () => {
        const { ir } = compileToIR('struct_basic.code');
        // Two store instructions for x and y
        const stores = ir.match(/store i32 %arg\.\d, i32\* %_f\d/g) ?? [];
        expect(stores.length).toBeGreaterThanOrEqual(2);
    });

    it('declares malloc before struct constructor', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toContain('declare i8* @malloc(i64)');
    });

    it('emits %Person = type { i8* } for string-field struct', () => {
        const { ir } = compileToIR('struct_string_field.code');
        expect(ir).toContain('%Person = type { i8* }');
    });

    it('emits @Person_new with i8* parameter', () => {
        const { ir } = compileToIR('struct_string_field.code');
        expect(ir).toMatch(/define private %Person\* @Person_new\(i8\* %arg\.0\)/);
    });
});

// =============================================================================
// 3. Field access IR
// =============================================================================

describe('Struct — field access IR', () => {

    it('p.x emits GEP index 0 + load i32', () => {
        const { ir } = compileToIR('struct_basic.code');
        // Expect getelementptr with field index 0 (temp register may have any number)
        expect(ir).toMatch(/getelementptr inbounds %Point, %Point\* %\d+, i32 0, i32 0/);
        expect(ir).toMatch(/load i32, i32\* %\d+/);
    });

    it('p.y emits GEP index 1 + load i32', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toMatch(/getelementptr inbounds %Point, %Point\* %\d+, i32 0, i32 1/);
    });

    it('p.name emits GEP + load i8*', () => {
        const { ir } = compileToIR('struct_string_field.code');
        expect(ir).toMatch(/getelementptr inbounds %Person, %Person\* %\d+, i32 0, i32 0/);
        expect(ir).toMatch(/load i8\*, i8\*\* %\d+/);
    });
});

// =============================================================================
// 4 + 5. Inline methods: self.field and dispatch
// =============================================================================

describe('Struct — inline method IR', () => {

    it('emits @Point_sum with %Point* self parameter', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toMatch(/define private i32 @Point_sum\(%Point\* %self\.0\)/);
    });

    it('@Point_sum accesses self.x via GEP', () => {
        const { ir } = compileToIR('struct_basic.code');
        // The method body should contain GEP for field 0 (x)
        expect(ir).toMatch(/define private i32 @Point_sum/);
        expect(ir).toMatch(/getelementptr inbounds %Point, %Point\* %\d+, i32 0, i32 0/);
    });

    it('emits @Point_scale with %Point* self and i32 factor', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toMatch(/define private i32 @Point_scale\(%Point\* %self\.0, i32 %arg\.0\)/);
    });

    it('call sites in main use @Point_sum correctly', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toMatch(/call i32 @Point_sum\(%Point\* %/);
    });

    it('call sites in main use @Point_scale correctly', () => {
        const { ir } = compileToIR('struct_basic.code');
        expect(ir).toMatch(/call i32 @Point_scale\(%Point\* %\d+, i32 3\)/);
    });

    it('emits @Person_greet with i8* return', () => {
        const { ir } = compileToIR('struct_string_field.code');
        expect(ir).toMatch(/define private i8\* @Person_greet\(%Person\* %self\.0\)/);
    });

    it('@Wrapper_append uses concat for self.prefix + suffix', () => {
        const { ir } = compileToIR('struct_with_self_method.code');
        expect(ir).toMatch(/call i8\* @concat\(i8\* %\d+, i8\* %\d+\)/);
    });
});

// =============================================================================
// 7. Runtime correctness
// =============================================================================

describe('Struct — runtime correctness', () => {

    it('Point: field x = 10', () => {
        const { stdout } = compileAndRun('struct_basic.code');
        expect(lines(stdout)[0]).toBe('10');
    });

    it('Point: field y = 20', () => {
        const { stdout } = compileAndRun('struct_basic.code');
        expect(lines(stdout)[1]).toBe('20');
    });

    it('Point: sum() = 30', () => {
        const { stdout } = compileAndRun('struct_basic.code');
        expect(lines(stdout)[2]).toBe('30');
    });

    it('Point: scale(3) = 30', () => {
        const { stdout } = compileAndRun('struct_basic.code');
        expect(lines(stdout)[3]).toBe('30');
    });

    it('Point: exits with code 0', () => {
        expect(compileAndRun('struct_basic.code').exitCode).toBe(0);
    });

    it('Person: name field = Alice', () => {
        const { stdout } = compileAndRun('struct_string_field.code');
        expect(lines(stdout)[0]).toBe('Alice');
    });

    it('Person: greet() returns name', () => {
        const { stdout } = compileAndRun('struct_string_field.code');
        expect(lines(stdout)[1]).toBe('Alice');
    });

    it('Person: exits with code 0', () => {
        expect(compileAndRun('struct_string_field.code').exitCode).toBe(0);
    });

    it('Container: doubled() = 42', () => {
        const { stdout } = compileAndRun('struct_generic_method.code');
        expect(lines(stdout)[1]).toBe('42');
    });

    it('Container: field value = 21', () => {
        const { stdout } = compileAndRun('struct_generic_method.code');
        expect(lines(stdout)[0]).toBe('21');
    });

    it('Wrapper: append() concatenates strings', () => {
        const { stdout } = compileAndRun('struct_with_self_method.code');
        expect(lines(stdout)[0]).toBe('Hello, world');
    });

    it('Wrapper: exits with code 0', () => {
        expect(compileAndRun('struct_with_self_method.code').exitCode).toBe(0);
    });
});

// =============================================================================
// 8. Protocol-bound syntax: T extends Proto
// =============================================================================

describe('Protocol bounds — T extends Proto syntax', () => {

    it('protocol_bounds.code compiles without error', () => {
        const result = compileAndRun('protocol_bounds.code');
        expect(result.exitCode).toBe(0);
    });

    it('identity<T> with int bound returns 42', () => {
        const { stdout } = compileAndRun('protocol_bounds.code');
        expect(lines(stdout)[0]).toBe('42');
    });

    it('identity<T> with string bound returns "hello"', () => {
        const { stdout } = compileAndRun('protocol_bounds.code');
        expect(lines(stdout)[1]).toBe('hello');
    });
});

// =============================================================================
// 9. Generic struct with protocol bounds
// =============================================================================

describe('Generic struct with protocol bounds', () => {

    it('compiles without error', () => {
        const result = compileAndRun('generic_struct_protocol.code');
        expect(result.exitCode).toBe(0);
    });

    it('MyCustom<string>.append("world") = "Hello, world"', () => {
        const { stdout } = compileAndRun('generic_struct_protocol.code');
        expect(lines(stdout)[0]).toBe('Hello, world');
    });

    it('MyCustom<Label>.append(lbl) dispatches Label.toString()', () => {
        const { stdout } = compileAndRun('generic_struct_protocol.code');
        expect(lines(stdout)[1]).toBe('Greet: CodeLang');
    });

    it('Box<string>.show() returns the string field', () => {
        const { stdout } = compileAndRun('generic_struct_protocol.code');
        expect(lines(stdout)[2]).toBe('boxed');
    });

    it('Box<Label>.show() dispatches Label.toString() via chained call', () => {
        const { stdout } = compileAndRun('generic_struct_protocol.code');
        expect(lines(stdout)[3]).toBe('labeled');
    });

    it('IR: MyCustom struct type definition is emitted', () => {
        const { ir } = compileToIR('generic_struct_protocol.code');
        expect(ir).toContain('%MyCustom = type { i8* }');
    });

    it('IR: MyCustom_new constructor is emitted', () => {
        const { ir } = compileToIR('generic_struct_protocol.code');
        expect(ir).toMatch(/define private %MyCustom\* @MyCustom_new\(i8\* %arg\.0\)/);
    });

    it('IR: Box struct type definition is emitted', () => {
        const { ir } = compileToIR('generic_struct_protocol.code');
        expect(ir).toContain('%Box = type { i8* }');
    });

    it('IR: Box.show uses GEP for self.value field access', () => {
        const { ir } = compileToIR('generic_struct_protocol.code');
        expect(ir).toMatch(/getelementptr inbounds %Box, %Box\* %\d+, i32 0, i32 0/);
    });

    it('IR: MyCustom.append uses concat for string concat', () => {
        const { ir } = compileToIR('generic_struct_protocol.code');
        expect(ir).toMatch(/call i8\* @concat\(i8\* %\d+, i8\* %\d+\)/);
    });
});
