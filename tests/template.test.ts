/**
 * Template-string integration tests.
 *
 * Exercises the $"..." syntax: variable interpolation, arithmetic holes,
 * multi-part concatenation, type coercion, escape sequences, literal braces,
 * member-access holes, and struct toString dispatch.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── Basic string interpolation ────────────────────────────────────────────────

describe('template strings — string variable', () => {
    it('interpolates a single string variable', () => {
        const { exitCode, stdout } = compileAndRun('template_basic.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('hello world\n');
    });
});

// ── Arithmetic in holes ───────────────────────────────────────────────────────

describe('template strings — arithmetic holes', () => {
    it('evaluates x + y, x * y, and constant arithmetic', () => {
        const { exitCode, stdout } = compileAndRun('template_expr.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('sum: 7\nproduct: 12\nconstant: 2\n');
    });
});

// ── Multiple types ────────────────────────────────────────────────────────────

describe('template strings — mixed types', () => {
    it('prints int, float, string, and bool holes', () => {
        const { exitCode, stdout } = compileAndRun('template_types.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('int: 42\nfloat: 3.14\nstring: world\nbool: true\n');
    });
});

// ── Multi-part interpolation ──────────────────────────────────────────────────

describe('template strings — multiple holes', () => {
    it('interpolates multiple variables in one string', () => {
        const { exitCode, stdout } = compileAndRun('template_multipart.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('Name: John Doe, Age: 30\n');
    });
});

// ── Escape sequences ──────────────────────────────────────────────────────────

describe('template strings — escape sequences', () => {
    it('processes \\n as a real newline inside the template', () => {
        const { exitCode, stdout } = compileAndRun('template_escape.code');
        expect(exitCode).toBe(0);
        // "hello 2\nworld" → print adds its own \n, so two lines + blank
        expect(stdout).toBe('hello 2\nworld\n');
    });
});

// ── Assign to variable ────────────────────────────────────────────────────────

describe('template strings — assigned to variable', () => {
    it('stores template result then prints it', () => {
        const { exitCode, stdout } = compileAndRun('template_assign.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('x=10, y=20, sum=30\n');
    });
});

// ── Literal braces ────────────────────────────────────────────────────────────
//
// { followed by a space/newline is a literal brace, not a hole.
// Only { immediately followed by [_a-zA-Z0-9] starts an expression hole.

describe('template strings — literal braces', () => {
    it('{ followed by space is a literal brace, not a hole', () => {
        const { exitCode, stdout } = compileAndRun('template_literal_braces.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe(
            'result: { 42 }\n' +
            'Point{ x: 42, y: 7 }\n' +
            'empty: {}\n',
        );
    });

    it('{ } with nothing inside are both literal braces', () => {
        const { stdout } = compileAndRun('template_literal_braces.code');
        expect(stdout).toContain('empty: {}');
    });

    it('struct-like format preserves surrounding literal braces', () => {
        const { stdout } = compileAndRun('template_literal_braces.code');
        // "Point{ x: 42, y: 7 }" — outer { and } are literals, {x} and {y} are holes
        expect(stdout).toContain('Point{ x: 42, y: 7 }');
    });
});

// ── Escape \{ and \} ─────────────────────────────────────────────────────────
//
// \{ and \} always produce literal braces, even before an identifier.

describe('template strings — \\{ escape sequence', () => {
    it('\\{x\\} produces a literal {x}, not evaluated', () => {
        const { exitCode, stdout } = compileAndRun('template_escape_brace.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('{x}\n{value: 99}\n');
    });

    it('\\{ before identifier forces literal brace', () => {
        const { stdout } = compileAndRun('template_escape_brace.code');
        // First line: \{x\} → literal "{x}", no interpolation
        expect(stdout.split('\n')[0]).toBe('{x}');
    });

    it('mix of escaped and real holes', () => {
        const { stdout } = compileAndRun('template_escape_brace.code');
        // Second line: \{value: {x}\} → {value: 99}
        expect(stdout.split('\n')[1]).toBe('{value: 99}');
    });
});

// ── No holes ──────────────────────────────────────────────────────────────────

describe('template strings — no interpolation holes', () => {
    it('template with no holes behaves like a plain string', () => {
        const { exitCode, stdout } = compileAndRun('template_no_holes.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('just plain text\nanother plain string\n');
    });
});

// ── Bool holes produce "true" / "false" strings ───────────────────────────────

describe('template strings — bool holes', () => {
    it('true in a hole produces the string "true"', () => {
        const { exitCode, stdout } = compileAndRun('template_bool_hole.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('t is true\nf is false\nboth: true and false\n');
    });

    it('true and false holes in same template', () => {
        const { stdout } = compileAndRun('template_bool_hole.code');
        expect(stdout).toContain('both: true and false');
    });
});

// ── Member access in holes ────────────────────────────────────────────────────
//
// {self.field} inside a struct method emits load + GEP + load for the field.

describe('template strings — member access holes', () => {
    it('self.x and self.y are evaluated correctly in toString()', () => {
        const { exitCode, stdout } = compileAndRun('template_member_access.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('Point{ x: 3, y: 4 }\nPoint{ x: 0, y: 0 }\n');
    });

    it('zero-valued struct fields render as 0', () => {
        const { stdout } = compileAndRun('template_member_access.code');
        expect(stdout).toContain('Point{ x: 0, y: 0 }');
    });
});

// ── Struct value in a hole → toString() dispatch ──────────────────────────────
//
// When a struct with a toString() method appears as a template hole, the
// IR generator emits a call to TypeName_toString and uses the result string.

describe('template strings — struct as hole (toString dispatch)', () => {
    it('struct in a hole calls toString() and concatenates the result', () => {
        const { exitCode, stdout } = compileAndRun('template_struct_tostring.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('vector: (10, 20)\n(10, 20)\n');
    });

    it('plain print(struct) also routes through toString()', () => {
        const { stdout } = compileAndRun('template_struct_tostring.code');
        // Second print(v) — not inside a template, but still calls toString()
        expect(stdout.split('\n')[1]).toBe('(10, 20)');
    });
});

// ── IR shape ──────────────────────────────────────────────────────────────────

describe('template strings — IR structure', () => {
    it('uses concat for multi-part template', () => {
        const { ir } = compileToIR('template_basic.code');
        expect(ir).toMatch(/@concat\(i8\*/);
    });

    it('emits declare for concat when not already declared', () => {
        const { ir } = compileToIR('template_basic.code');
        expect(ir).toMatch(/declare i8\* @concat\(i8\*, i8\*\)/);
    });

    it('emits declare for int_to_string when int holes are used', () => {
        const { ir } = compileToIR('template_expr.code');
        expect(ir).toMatch(/declare i8\* @int_to_string\(i32\)/);
    });

    it('template literal parts are stored as raw string constants', () => {
        const { ir } = compileToIR('template_basic.code');
        // "hello " is a raw constant (no trailing \n)
        expect(ir).toMatch(/hello \\00/);
    });

    it('bool hole uses select i1 to choose "true" or "false" string', () => {
        const { ir } = compileToIR('template_bool_hole.code');
        expect(ir).toMatch(/select i1.*i8\*.*i8\*/);
    });

    it('literal-brace template emits three concat calls for three parts', () => {
        const { ir } = compileToIR('template_literal_braces.code');
        // "result: { " + <hole> + " }" requires two concat calls
        const concatCount = (ir.match(/@concat\(/g) ?? []).length;
        expect(concatCount).toBeGreaterThanOrEqual(2);
    });

    it('member-access hole emits GEP for field access', () => {
        const { ir } = compileToIR('template_member_access.code');
        expect(ir).toMatch(/getelementptr inbounds %Point/);
    });

    it('struct-as-hole emits call to TypeName_toString', () => {
        const { ir } = compileToIR('template_struct_tostring.code');
        expect(ir).toMatch(/call i8\* @Vec2_toString/);
    });
});

// ── Closures: string variable captured only via template holes ────────────────
//
// Regression test for the bug where a string captured by a closure was only
// referenced inside a template literal hole (`$"{greeting}, {name}!"`).
// Because template-literal holes embed variable names as raw text (not as
// VariableRef AST nodes), `collectCaptures` previously missed them, so the
// captured variable was never added to the env struct.  The slot then received
// an `undef` i8* at IR level, causing "Alice, Alice!" instead of "Hello, Alice!".

describe('template strings — closure captures string via template hole', () => {
    it('closure captures a string used only in a template hole (runtime)', () => {
        const { exitCode, stdout } = compileAndRun('closure_template_string.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('Hello, Alice!\nHello, Bob!\nHi, World!\n');
    });

    it('closure captures a string used only in a template hole (IR)', () => {
        const { ir } = compileToIR('closure_template_string.code');
        // `greeting` must appear in the env struct as an i8* field
        expect(ir).toMatch(/%__lambda_\d+_env = type \{ i8\* \}/);
        // The env must be heap-allocated (closure, not null)
        expect(ir).toMatch(/call i8\* @malloc/);
        // Two separate loads inside the lambda body — one for greeting, one for name
        const loadCount = (ir.match(/load i8\*, i8\*\* %(?:greeting|name)/g) ?? []).length;
        expect(loadCount).toBeGreaterThanOrEqual(2);
    });
});

// ── Static type method calls in template holes ────────────────────────────────
//
// Before the fix, {OS.arch()} in a template hole produced "undef" because
// parseMiniExpr produced a `member` node whose obj was not in varCtx.
// Now the generator routes static/namespace calls through emitMiniStaticCall.

describe('template strings — static method calls in holes', () => {
    it('compiles without error', () => {
        const { exitCode } = compileToIR('template_static_call.code');
        expect(exitCode).toBe(0);
    });

    it('{OS.arch()} emits a call to @OS_arch in the IR', () => {
        const { ir } = compileToIR('template_static_call.code');
        expect(ir).toMatch(/call i8\* @OS_arch\(\)/);
    });

    it('{OS.platform()} emits a call to @OS_platform in the IR', () => {
        const { ir } = compileToIR('template_static_call.code');
        expect(ir).toMatch(/call i8\* @OS_platform\(\)/);
    });

    it('{double_it(n)} loads n and calls @double_it with the loaded value', () => {
        const { ir } = compileToIR('template_static_call.code');
        expect(ir).toMatch(/call i32 @double_it\(i32 %\d+\)/);
    });

    it('{greet(who)} loads who and calls @greet with the loaded pointer', () => {
        const { ir } = compileToIR('template_static_call.code');
        expect(ir).toMatch(/call i8\* @greet\(i8\* %\d+\)/);
    });

    it('static call result is fed into @concat (not undef)', () => {
        const { ir } = compileToIR('template_static_call.code');
        // The OS_arch() result should be used as the second arg to concat, not undef
        expect(ir).not.toMatch(/concat\(i8\* [^,]+, i8\* undef\)/);
    });
});
