/**
 * Extension method tests.
 *
 * Tests Swift-style extensions (ExtensionDeclaration) that add methods
 * to existing types. Exercises grammar, IR generation, and runtime behaviour.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

describe('extensions — Boolean methods', () => {
    it('toString(), toNumber(), not() via imported stdlib/boolean', () => {
        const { exitCode, stdout } = compileAndRun('bool_extension.code');
        expect(exitCode).toBe(0);
        // true.toString()  → "true"
        // false.toString() → "false"
        // true.toNumber()  → 1
        // false.toNumber() → 0
        // false.not()      → "true"  (not(false) = true; Boolean has toString → prints "true")
        expect(stdout).toBe('true\nfalse\n1\n0\ntrue\n');
    });
});

describe('extensions — IR shape', () => {
    it('emits @Boolean_toString function with self parameter', () => {
        const { ir } = compileToIR('bool_extension.code');
        expect(ir).toMatch(/@Boolean_toString\(i1 %self\.0\)/);
    });

    it('extension method has self alloca in entry block', () => {
        const { ir } = compileToIR('bool_extension.code');
        expect(ir).toMatch(/%self = alloca i1/);
    });
});
