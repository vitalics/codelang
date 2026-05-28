/**
 * Runtime tests
 *
 * Compiles fixture programs to native binaries and checks the actual stdout
 * they produce when executed.  These are the highest-fidelity tests — if they
 * pass the full pipeline (parser → validator → IR → clang → OS) is working.
 *
 * Each test compiles to a private temp directory and cleans up after itself.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

describe('runtime — print()', () => {
    it('prints a string literal followed by a newline', () => {
        const { exitCode, stdout } = compileAndRun('hello.code');

        expect(exitCode).toBe(0);
        // hello.code: naive recursive fibo(100) → exact BigInt
        expect(stdout).toBe('Hello, CodeLang!\n354224848179261915075\n');
    });

    it('prints multiple lines in declaration order', () => {
        const { exitCode, stdout } = compileAndRun('multi_print.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('line one\nline two\n');
    });
});

describe('runtime — let variables', () => {
    it('prints the reassigned value (not the initial one)', () => {
        const { exitCode, stdout } = compileAndRun('let_reassign.code');

        expect(exitCode).toBe(0);
        // After `msg = "second"`, print(msg) should output "second"
        expect(stdout).toBe('second\n');
    });
});

describe('runtime — const variables', () => {
    it('prints the value of a const binding', () => {
        const { exitCode, stdout } = compileAndRun('const_var.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('constant value\n');
    });
});

describe('runtime — typed variables (smoke)', () => {
    it('compiles and runs a program with int and bool vars', () => {
        const { exitCode, stdout } = compileAndRun('typed_vars.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('typed vars ok\n');
    });
});

describe('runtime — const fn present but not called', () => {
    it('runs a program that declares a const fn alongside main', () => {
        const { exitCode, stdout } = compileAndRun('const_fn_pure.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('const fn ok\n');
    });
});

describe('runtime — struct inheritance (extends)', () => {
    it('flat inheritance: child accesses parent fields and sums them', () => {
        // type_extends_struct.code: Point3D extends Point { z: int }
        // Point3D.new(1,2,3).sum() = 1+2+3 = 6
        const { exitCode, stdout } = compileAndRun('type_extends_struct.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('6\n');
    });

    it('spread in struct literal copies parent fields', () => {
        // struct_spread.code: Vec3 extends Vec2 { z: int }
        // Vec3.new(Vec2.new(3,4), 0).mag2() = 3²+4²+0² = 25
        const { exitCode, stdout } = compileAndRun('struct_spread.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('25\n');
    });
});

describe('runtime — stdlib path imports', () => {
    it('import "stdlib/buffer" resolves and compiles correctly', () => {
        // stdlib_import.code: import "stdlib/buffer"; buffer_new(4).length() == 4
        const { exitCode, stdout } = compileAndRun('stdlib_import.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('4\n');
    });
});

describe('runtime — callable types (Callable protocol)', () => {
    it('MyType(args) desugars to @MyType_call and template literal works', () => {
        // callable_type.code:
        //   type MyType extends Callable<int, int> { call(n: int): int { ... } }
        //   MyType(500) → prints "This is value: 500" then returns 5
        const { exitCode, stdout } = compileAndRun('callable_type.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('This is value: 500\n5\n');
    });

    it('tuple-spread form: Callable<[T1,T2], R> spreads into multi-arg call', () => {
        // callable_multi_arg.code:
        //   type Add  extends Callable<[int, int], int>       → call(a, b)
        //   type Sum3 extends Callable<[int, int, int], int>  → call(a, b, c)
        //   Add(10, 20) == 30   Sum3(1, 2, 3) == 6
        const { exitCode, stdout } = compileAndRun('callable_multi_arg.code');

        expect(exitCode).toBe(0);
        expect(stdout).toBe('30\n6\n');
    });
});
