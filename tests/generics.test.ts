import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

describe('Generics — type Box<T> = T alias', () => {
    it('Box<int> resolves to i32 — alloca i32', () => {
        const { ir } = compileToIR('generics_box.code');
        expect(ir).toMatch(/%a = alloca i32/);
    });
    it('Box<string> resolves to i8* — alloca i8*', () => {
        const { ir } = compileToIR('generics_box.code');
        expect(ir).toMatch(/%b = alloca i8\*/);
    });
    it('Box<int> value 99 prints correctly', () => {
        const { stdout } = compileAndRun('generics_box.code');
        expect(lines(stdout)[0]).toBe('99');
    });
    it('Box<string> value "boxed" prints correctly', () => {
        const { stdout } = compileAndRun('generics_box.code');
        expect(lines(stdout)[1]).toBe('boxed');
    });
    it('exits with code 0', () => {
        expect(compileAndRun('generics_box.code').exitCode).toBe(0);
    });
});

describe('Generics — fn identity<T>', () => {
    it('emits specialized @identity_i32 for int argument', () => {
        const { ir } = compileToIR('generics_identity.code');
        expect(ir).toMatch(/define .* @identity_i32\(i32/);
    });
    it('emits specialized @identity_str for string argument', () => {
        const { ir } = compileToIR('generics_identity.code');
        expect(ir).toMatch(/define .* @identity_str\(i8\*/);
    });
    it('identity(42) returns 42', () => {
        const { stdout } = compileAndRun('generics_identity.code');
        expect(lines(stdout)[0]).toBe('42');
    });
    it('identity("hello") returns "hello"', () => {
        const { stdout } = compileAndRun('generics_identity.code');
        expect(lines(stdout)[1]).toBe('hello');
    });
    it('exits with code 0', () => {
        expect(compileAndRun('generics_identity.code').exitCode).toBe(0);
    });
});
