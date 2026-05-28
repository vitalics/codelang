/**
 * Reflection tests — typeInfo<T>(), Field metadata.
 *
 * Exercises the reflection API introduced by stdlib/reflection.code:
 *
 *   typeInfo(value)          — infer type from argument
 *   typeInfo<T>(value)       — explicit type argument
 *   TypeInfo.name()          — CodeLang type name
 *   TypeInfo.fields()        — ordered list of members (fields + methods)
 *   TypeInfo.properties()    — only struct fields (isFunction == 0)
 *   TypeInfo.functions()     — only methods       (isFunction == 1)
 *   Array<Field>.length()    — member count
 *   Array<Field>.get(i)      — member by index
 *
 * Each Field / PropertyField / FunctionField exposes:
 *   name()           — member identifier
 *   typeName()       — field type / method return type (CodeLang name)
 *   isProperty()     — reserved (always 0 today)
 *   isExportable()   — true for `export fn …` methods
 *   isFunction()     — 0 for fields, 1 for methods
 *   isDisposable()   — true for `using field: T` declarations
 *   isConst()        — true for `const field: T` / `const fn …` declarations
 *   returnType()     — same as typeName() for plain fields
 *   isInitialized()  — true when the field has a compile-time initializer
 *   getValue()       — initializer as string (e.g. "[1, 2, 4]") or ""
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

// ── Shared compilation cache ──────────────────────────────────────────────────
//
// Previously every test called compileAndRun/compileToIR independently,
// spawning 58+ compiler processes simultaneously and overwhelming the system.
// Now each of the three fixtures is compiled ONCE in beforeAll; the results
// are shared across all tests that use that fixture.

let reflectionLines:      string[]    = [];
let reflectionIR:         string      = '';
let reflectionExitCode:   number|null = null;

let fieldsLines:          string[]    = [];
let fieldsIR:             string      = '';
let fieldsExitCode:       number|null = null;

let propertiesLines:      string[]    = [];  // stdout.trim().split('\n')
let propertiesAllLines:   string[]    = [];  // stdout.split('\n') — preserves blank lines
let propertiesIR:         string      = '';
let propertiesExitCode:   number|null = null;

beforeAll(() => {
    // compileAndRun() now also returns the IR (the CLI saves the .ll file as an
    // intermediate during full compilation, so no extra compileToIR pass needed).

    // ── reflection.code ───────────────────────────────────────────────────────
    const rRun = compileAndRun('reflection.code');
    reflectionExitCode = rRun.exitCode;
    reflectionLines    = rRun.stdout.trim().split('\n');
    reflectionIR       = rRun.ir;

    // ── reflection_fields.code ────────────────────────────────────────────────
    const fRun = compileAndRun('reflection_fields.code');
    fieldsExitCode = fRun.exitCode;
    fieldsLines    = fRun.stdout.trim().split('\n');
    fieldsIR       = fRun.ir;

    // ── reflection_properties.code ────────────────────────────────────────────
    const pRun = compileAndRun('reflection_properties.code');
    propertiesExitCode = pRun.exitCode;
    propertiesLines    = pRun.stdout.trim().split('\n');
    propertiesAllLines = pRun.stdout.split('\n');
    propertiesIR       = pRun.ir;
});

// ── Primitive-type reflection ─────────────────────────────────────────────────

describe('reflection — primitive types', () => {
    it('typeInfo(bool) name is "bool"', () => {
        expect(reflectionExitCode).toBe(0);
        expect(reflectionLines[0]).toBe('bool');
    });

    it('typeInfo<int>() name is "int"', () => {
        expect(reflectionLines[1]).toBe('int');
    });
});

// ── Struct-type reflection — basic ────────────────────────────────────────────

describe('reflection — struct fields (basic)', () => {
    it('typeInfo(point) name is "Point"', () => {
        expect(reflectionLines[2]).toBe('Point');
    });

    it('Point has 2 fields', () => {
        expect(reflectionLines[3]).toBe('2');
    });

    it('fields.get(0).name() is "x"', () => {
        expect(reflectionLines[4]).toBe('x');
    });

    it('fields.get(0).typeName() is "int"', () => {
        expect(reflectionLines[5]).toBe('int');
    });

    it('plain int field: isConst() is 0', () => {
        expect(reflectionLines[6]).toBe('0');
    });

    it('plain int field: isFunction() is 0', () => {
        expect(reflectionLines[7]).toBe('0');
    });

    it('plain int field: isDisposable() is 0', () => {
        expect(reflectionLines[8]).toBe('0');
    });

    it('plain int field: isExportable() is 0', () => {
        expect(reflectionLines[9]).toBe('0');
    });

    it('plain int field: returnType() is "int"', () => {
        expect(reflectionLines[10]).toBe('int');
    });

    it('fields.get(1).name() is "y"', () => {
        expect(reflectionLines[11]).toBe('y');
    });

    it('cast(Any) result is accessible after typeInfo call', () => {
        expect(reflectionLines[12]).toBe('hello');
    });
});

// ── Struct-type reflection — IR structure ─────────────────────────────────────

describe('reflection — IR structure', () => {
    it('declares @field_new with 10 parameters', () => {
        expect(reflectionIR).toMatch(/declare %Field\* @field_new\(i8\*, i8\*, i32, i32, i32, i32, i32, i8\*, i32, i8\*\)/);
    });

    it('declares all Field accessor functions', () => {
        expect(reflectionIR).toContain('declare i32 @field_is_property(%Field*)');
        expect(reflectionIR).toContain('declare i32 @field_is_exportable(%Field*)');
        expect(reflectionIR).toContain('declare i32 @field_is_function(%Field*)');
        expect(reflectionIR).toContain('declare i32 @field_is_disposable(%Field*)');
        expect(reflectionIR).toContain('declare i32 @field_is_const(%Field*)');
        expect(reflectionIR).toContain('declare i8* @field_return_type(%Field*)');
        expect(reflectionIR).toContain('declare i32 @field_is_initialized(%Field*)');
        expect(reflectionIR).toContain('declare i8* @field_get_value(%Field*)');
    });

    it('emits @field_new calls with 10-param signature for struct fields', () => {
        // Flags: isProperty=0, isExportable=0, isFunction=0, isDisposable=0, isConst=0, ..., isInitialized=0
        expect(reflectionIR).toMatch(/call %Field\* @field_new\(.*i32 0, i32 0, i32 0, i32 0, i32 0.*i32 0, i8\*/);
    });

    it('uses PtrArray (not a custom FieldArray) to store field lists', () => {
        // FieldArray is now Array<Field> → %PtrArray* at the LLVM level
        expect(reflectionIR).toContain('%PtrArray = type opaque');
        expect(reflectionIR).toContain('declare %PtrArray* @ptrarray_new()');
        expect(reflectionIR).toContain('declare void @ptrarray_push(%PtrArray*, i8*)');
        // typeinfo_new now takes %PtrArray* instead of %FieldArray*
        expect(reflectionIR).toContain('declare %TypeInfo* @typeinfo_new(i8*, %PtrArray*)');
        // typeinfo_fields/properties/functions return %PtrArray*
        expect(reflectionIR).toContain('declare %PtrArray* @typeinfo_fields(%TypeInfo*)');
    });

    it('pushes Field* into PtrArray via bitcast to i8*', () => {
        // Field* pushed as i8* (void*) into the PtrArray
        expect(reflectionIR).toMatch(/bitcast %Field\* %\S+ to i8\*/);
        // And retrieved with bitcast back to %Field* when type-annotated
        expect(reflectionIR).toMatch(/bitcast i8\* %\S+ to %Field\*/);
    });

    it('does NOT declare a custom %FieldArray type', () => {
        expect(reflectionIR).not.toContain('%FieldArray');
        expect(reflectionIR).not.toContain('fieldarray_new');
        expect(reflectionIR).not.toContain('fieldarray_push');
        expect(reflectionIR).not.toContain('fieldarray_length');
    });
});

// ── Enhanced Field metadata — fields with modifiers ──────────────────────────

describe('reflection — field modifiers (isConst, isDisposable)', () => {
    it('total member count is 6 (3 fields + 3 methods)', () => {
        expect(fieldsExitCode).toBe(0);
        expect(fieldsLines[1]).toBe('6');
    });

    it('using resource field: isDisposable() is 1', () => {
        // line index 6 = m0.isDisposable()
        expect(fieldsLines[6]).toBe('1');
    });

    it('using resource field: isConst() is 0', () => {
        // line index 5 = m0.isConst()
        expect(fieldsLines[5]).toBe('0');
    });

    it('const balance field: isConst() is 1', () => {
        // line index 9 = m1.isConst()
        expect(fieldsLines[9]).toBe('1');
    });

    it('const balance field: isDisposable() is 0', () => {
        // line index 10 = m1.isDisposable()
        expect(fieldsLines[10]).toBe('0');
    });

    it('plain name field: typeName() is "string"', () => {
        // line index 12 = m2.typeName()
        expect(fieldsLines[12]).toBe('string');
    });

    it('plain name field: isConst() is 0', () => {
        // line index 13 = m2.isConst()
        expect(fieldsLines[13]).toBe('0');
    });
});

// ── Enhanced Field metadata — method reflection ───────────────────────────────

describe('reflection — method members (isFunction, isExportable, isConst)', () => {
    it('export fn deposit: isFunction() is 1', () => {
        // line 15 = m3.isFunction()
        expect(fieldsLines[15]).toBe('1');
    });

    it('export fn deposit: isExportable() is 1', () => {
        // line 16 = m3.isExportable()
        expect(fieldsLines[16]).toBe('1');
    });

    it('export fn deposit: isConst() is 0 (non-comptime)', () => {
        // line 17 = m3.isConst()
        expect(fieldsLines[17]).toBe('0');
    });

    it('export const fn getBalance: isConst() is 1 (comptime)', () => {
        // line 21 = m4.isConst()
        expect(fieldsLines[21]).toBe('1');
    });

    it('export const fn getBalance: returnType() is "int"', () => {
        // line 22 = m4.returnType()
        expect(fieldsLines[22]).toBe('int');
    });

    it('fn internalReset: isExportable() is 0 (not exported)', () => {
        // line 25 = m5.isExportable()
        expect(fieldsLines[25]).toBe('0');
    });

    it('fn internalReset: isFunction() is 1', () => {
        // line 24 = m5.isFunction()
        expect(fieldsLines[24]).toBe('1');
    });
});

// ── IR: field_new flag combinations ──────────────────────────────────────────

describe('reflection — IR flag patterns', () => {
    it('using field emits isDisposable=1 in field_new call', () => {
        // For "using resource: int": flags = isProperty=0, isExportable=0, isFunction=0, isDisposable=1, isConst=0
        expect(fieldsIR).toMatch(/call %Field\* @field_new\(.*i32 0, i32 0, i32 0, i32 1, i32 0/);
    });

    it('const field emits isConst=1 in field_new call', () => {
        // For "const balance: int": flags = isProperty=0, isExportable=0, isFunction=0, isDisposable=0, isConst=1
        expect(fieldsIR).toMatch(/call %Field\* @field_new\(.*i32 0, i32 0, i32 0, i32 0, i32 1/);
    });

    it('export fn method emits isFunction=1, isExportable=1 in field_new call', () => {
        // For "export fn deposit": flags = isProperty=0, isExportable=1, isFunction=1, isDisposable=0, isConst=0
        expect(fieldsIR).toMatch(/call %Field\* @field_new\(.*i32 0, i32 1, i32 1, i32 0, i32 0/);
    });

    it('export const fn method emits isFunction=1, isExportable=1, isConst=1 in field_new call', () => {
        // For "export const fn getBalance": flags = isProperty=0, isExportable=1, isFunction=1, isDisposable=0, isConst=1
        expect(fieldsIR).toMatch(/call %Field\* @field_new\(.*i32 0, i32 1, i32 1, i32 0, i32 1/);
    });

    it('initialized field emits isInitialized=1 and initialValue string in field_new call', () => {
        // const weights: int[3; 1,2,4] = [1,2,4] → isInitialized=1
        expect(propertiesIR).toMatch(/call %Field\* @field_new\(.*i32 1, i8\*/);
    });

    it('uninitialized field emits isInitialized=0 in field_new call', () => {
        // timeout: int → isInitialized=0
        expect(propertiesIR).toMatch(/call %Field\* @field_new\(.*i32 0, i32 0, i32 0, i32 0, i32 0.*i32 0, i8\*/);
    });
});

// ── TypeInfo.properties() and TypeInfo.functions() ───────────────────────────

describe('reflection — TypeInfo.properties() / functions()', () => {
    it('properties() returns only struct fields (length 2)', () => {
        expect(propertiesExitCode).toBe(0);
        // line [2] = props.length()
        expect(propertiesLines[2]).toBe('2');
    });

    it('functions() returns only methods (length 2)', () => {
        // line [13] = fns.length()
        expect(propertiesLines[13]).toBe('2');
    });

    it('first property is "weights"', () => {
        // line [3] = p0.name()
        expect(propertiesLines[3]).toBe('weights');
    });

    it('weights field: isInitialized() is 1', () => {
        // line [5] = p0.isInitialized()
        expect(propertiesLines[5]).toBe('1');
    });

    it('weights field: getValue() is "[1, 2, 4]"', () => {
        // line [6] = p0.getValue()
        expect(propertiesLines[6]).toBe('[1, 2, 4]');
    });

    it('weights field: isFunction() is 0', () => {
        // line [7] = p0.isFunction()
        expect(propertiesLines[7]).toBe('0');
    });

    it('second property is "timeout"', () => {
        expect(propertiesLines[8]).toBe('timeout');
    });

    it('timeout field: isInitialized() is 0', () => {
        // line [10] = p1.isInitialized()
        expect(propertiesLines[10]).toBe('0');
    });

    it('timeout field: getValue() is empty string', () => {
        // line index 11 in full output (before trim) = p1.getValue() = ""
        // After split on newline, empty-string getValue prints as blank line
        expect(propertiesAllLines[11]).toBe('');
    });

    it('first function is "getTimeout"', () => {
        // line [14] = f0.name()
        expect(propertiesLines[14]).toBe('getTimeout');
    });

    it('getTimeout: isFunction() is 1', () => {
        expect(propertiesLines[15]).toBe('1');
    });

    it('getTimeout: isExportable() is 1', () => {
        expect(propertiesLines[16]).toBe('1');
    });

    it('getTimeout: isConst() is 1 (comptime)', () => {
        expect(propertiesLines[17]).toBe('1');
    });

    it('getTimeout: returnType() is "int"', () => {
        expect(propertiesLines[18]).toBe('int');
    });

    it('getTimeout: isInitialized() is 0 (methods have no initializer)', () => {
        expect(propertiesLines[19]).toBe('0');
    });

    it('second function is "reset"', () => {
        // After getValue() empty line: reset is at line [21] in trimmed output
        expect(propertiesLines[21]).toBe('reset');
    });

    it('reset: isExportable() is 1', () => {
        expect(propertiesLines[22]).toBe('1');
    });

    it('reset: isConst() is 0 (non-comptime)', () => {
        expect(propertiesLines[23]).toBe('0');
    });

    it('declares @typeinfo_properties and @typeinfo_functions in IR (return PtrArray*)', () => {
        expect(propertiesIR).toContain('declare %PtrArray* @typeinfo_properties(%TypeInfo*)');
        expect(propertiesIR).toContain('declare %PtrArray* @typeinfo_functions(%TypeInfo*)');
    });
});
