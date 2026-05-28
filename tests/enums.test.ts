import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// ── IR structure helpers ──────────────────────────────────────────────────────

describe('Enums — IR structure', () => {
    it('simple enum emits base struct type', () => {
        const { ir } = compileToIR('enum_simple.code');
        expect(ir).toMatch(/%Direction = type \{ i32 \}/);
    });

    it('simple enum emits constructor functions', () => {
        const { ir } = compileToIR('enum_simple.code');
        expect(ir).toMatch(/define private %Direction\* @Direction_North\(\)/);
        expect(ir).toMatch(/define private %Direction\* @Direction_East\(\)/);
    });

    it('simple enum constructor stores correct tag', () => {
        const { ir } = compileToIR('enum_simple.code');
        // North = tag 0
        expect(ir).toMatch(/store i32 0,.*@Direction_North/s);
        // East = tag 10 (explicit)
        expect(ir).toMatch(/store i32 10,.*@Direction_East/s);
    });

    it('tagged union emits base and variant struct types', () => {
        const { ir } = compileToIR('enum_tagged_union.code');
        expect(ir).toMatch(/%Shape = type \{ i32 \}/);
        expect(ir).toMatch(/%Shape_Circle = type \{ i32, double \}/);
        expect(ir).toMatch(/%Shape_Rect = type \{ i32, double, double \}/);
    });

    it('tagged union emits payload constructor', () => {
        const { ir } = compileToIR('enum_tagged_union.code');
        expect(ir).toMatch(/define private %Shape\* @Shape_Circle\(double/);
        expect(ir).toMatch(/define private %Shape\* @Shape_Rect\(double.*double/);
    });

    it('enum inline method is emitted', () => {
        const { ir } = compileToIR('enum_tagged_union.code');
        expect(ir).toMatch(/define private double @Shape_area\(%Shape\*/);
    });

    it('enum switch arm bitcasts to variant pointer', () => {
        const { ir } = compileToIR('enum_tagged_union.code');
        expect(ir).toMatch(/bitcast %Shape\* .* to %Shape_Circle\*/);
    });

    it('generic enum emits concrete instantiation types', () => {
        const { ir } = compileToIR('enum_generic.code');
        expect(ir).toMatch(/%Option_i32 = type \{ i32 \}/);
        expect(ir).toMatch(/%Option_i32_Some = type \{ i32, i32 \}/);
        expect(ir).toMatch(/%Result_i32_i8 = type \{ i32 \}/);
        expect(ir).toMatch(/%Result_i32_i8_Err = type \{ i32, i8\* \}/);
    });

    it('recursive enum uses pointer type for self-referential fields', () => {
        const { ir } = compileToIR('enum_recursive.code');
        // Expr::Add(Expr, Expr) → %Expr_Add = type { i32, %Expr*, %Expr* }
        expect(ir).toMatch(/%Expr_Add = type \{ i32, %Expr\*, %Expr\* \}/);
        expect(ir).toMatch(/%Expr_Mul = type \{ i32, %Expr\*, %Expr\* \}/);
        expect(ir).toMatch(/%Expr_Neg = type \{ i32, %Expr\* \}/);
    });

    it('malloc is declared exactly once', () => {
        const { ir } = compileToIR('enum_simple.code');
        const count = (ir.match(/^declare i8\* @malloc/gm) ?? []).length;
        expect(count).toBe(1);
    });
});

// ── Runtime output ────────────────────────────────────────────────────────────

describe('Enums — simple enum runtime', () => {
    it('Direction::North prints "north"', () => {
        const { stdout } = compileAndRun('enum_simple.code');
        expect(lines(stdout)[0]).toBe('north');
    });

    it('Direction::East prints "east"', () => {
        const { stdout } = compileAndRun('enum_simple.code');
        expect(lines(stdout)[1]).toBe('east');
    });

    it('produces exactly 2 lines of output', () => {
        const { stdout } = compileAndRun('enum_simple.code');
        expect(lines(stdout)).toHaveLength(2);
    });

    it('exits with code 0', () => {
        expect(compileAndRun('enum_simple.code').exitCode).toBe(0);
    });
});

describe('Enums — tagged union runtime', () => {
    it('Shape::Circle(5.0).area() ≈ 78.54', () => {
        const { stdout } = compileAndRun('enum_tagged_union.code');
        const v = parseFloat(lines(stdout)[0]);
        expect(v).toBeCloseTo(78.54, 1);
    });

    it('Shape::Rect(3.0, 4.0).area() == 12', () => {
        const { stdout } = compileAndRun('enum_tagged_union.code');
        expect(parseFloat(lines(stdout)[1])).toBeCloseTo(12.0, 5);
    });

    it('Shape::Point.area() == 0', () => {
        const { stdout } = compileAndRun('enum_tagged_union.code');
        expect(parseFloat(lines(stdout)[2])).toBe(0);
    });

    it('produces exactly 3 lines of output', () => {
        const { stdout } = compileAndRun('enum_tagged_union.code');
        expect(lines(stdout)).toHaveLength(3);
    });

    it('exits with code 0', () => {
        expect(compileAndRun('enum_tagged_union.code').exitCode).toBe(0);
    });
});

describe('Enums — protocol conformance runtime', () => {
    it('Color::Green.toString() == "Green" (inline protocol)', () => {
        const { stdout } = compileAndRun('enum_protocol.code');
        expect(lines(stdout)[0]).toBe('Green');
    });

    it('Color::Green.toHex() == "#00FF00" (inline own method)', () => {
        const { stdout } = compileAndRun('enum_protocol.code');
        expect(lines(stdout)[1]).toBe('#00FF00');
    });

    it('Weekday::Sat.toString() == "Saturday" (separate extends block)', () => {
        const { stdout } = compileAndRun('enum_protocol.code');
        expect(lines(stdout)[2]).toBe('Saturday');
    });

    it('Weekday::Sat.isWeekend() == true → 1', () => {
        const { stdout } = compileAndRun('enum_protocol.code');
        expect(lines(stdout)[3]).toBe('true');
    });

    it('Weekday::Mon.isWeekend() == false → 0', () => {
        const { stdout } = compileAndRun('enum_protocol.code');
        expect(lines(stdout)[4]).toBe('false');
    });

    it('produces exactly 5 lines of output', () => {
        const { stdout } = compileAndRun('enum_protocol.code');
        expect(lines(stdout)).toHaveLength(5);
    });

    it('exits with code 0', () => {
        expect(compileAndRun('enum_protocol.code').exitCode).toBe(0);
    });
});

describe('Enums — generic tagged union runtime', () => {
    it('unwrap_or(Some(42), 0) == 42', () => {
        const { stdout } = compileAndRun('enum_generic.code');
        expect(lines(stdout)[0]).toBe('42');
    });

    it('unwrap_or(None, 99) == 99', () => {
        const { stdout } = compileAndRun('enum_generic.code');
        expect(lines(stdout)[1]).toBe('99');
    });

    it('is_ok(Ok(1)) == true → 1', () => {
        const { stdout } = compileAndRun('enum_generic.code');
        expect(lines(stdout)[2]).toBe('true');
    });

    it('is_ok(Err("oops")) == false → 0', () => {
        const { stdout } = compileAndRun('enum_generic.code');
        expect(lines(stdout)[3]).toBe('false');
    });

    it('produces exactly 4 lines of output', () => {
        const { stdout } = compileAndRun('enum_generic.code');
        expect(lines(stdout)).toHaveLength(4);
    });

    it('exits with code 0', () => {
        expect(compileAndRun('enum_generic.code').exitCode).toBe(0);
    });
});

describe('Enums — recursive tagged union runtime', () => {
    it('(1 + 2) * -(3) evaluates to -9', () => {
        const { stdout } = compileAndRun('enum_recursive.code');
        expect(lines(stdout)[0]).toBe('-9');
    });

    it('produces exactly 1 line of output', () => {
        const { stdout } = compileAndRun('enum_recursive.code');
        expect(lines(stdout)).toHaveLength(1);
    });

    it('exits with code 0', () => {
        expect(compileAndRun('enum_recursive.code').exitCode).toBe(0);
    });
});
