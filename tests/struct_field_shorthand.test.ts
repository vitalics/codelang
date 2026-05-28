/**
 * Tests for the struct field shorthand initializer syntax.
 *
 * `name,` inside a struct literal is equivalent to `name: name`.
 * The variable of the same name is used to fill the field.
 *
 * Covers:
 *   - Shorthand for all fields:       `Point { x, y }`
 *   - Mix of shorthand and named:     `Named { label, value: 42 }`
 *   - Shorthand in a function return: `fn makePoint(x, y) { return Point { x, y } }`
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun }        from './helpers/cli.js';

function lines(): string[] {
    return compileAndRun('struct_field_shorthand.code').stdout.trim().split('\n');
}

describe('struct field shorthand initializer', () => {
    it('compiles without error', () =>
        expect(compileAndRun('struct_field_shorthand.code').exitCode).toBe(0));

    // Direct literal: Point { x, y }
    it('p.x is 10 (shorthand fills from variable x=10)', () =>
        expect(lines()[0]).toBe('10'));

    it('p.y is 20 (shorthand fills from variable y=20)', () =>
        expect(lines()[1]).toBe('20'));

    // Mixed shorthand + named: Named { label, value: 42 }
    it('n.label is "hello" (shorthand fills from variable label)', () =>
        expect(lines()[2]).toBe('hello'));

    it('n.value is 42 (explicit named init)', () =>
        expect(lines()[3]).toBe('42'));

    // Shorthand via function return: makePoint(3, 7)
    it('q.x is 3 (shorthand in function body)', () =>
        expect(lines()[4]).toBe('3'));

    it('q.y is 7 (shorthand in function body)', () =>
        expect(lines()[5]).toBe('7'));

    // Full output check
    it('all output lines are correct', () =>
        expect(lines()).toEqual(['10', '20', 'hello', '42', '3', '7']));
});
