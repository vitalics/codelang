/**
 * Tests for generic protocol conformance validation.
 *
 * Bug fixed: when a type explicitly provides a concrete type argument to a
 * generic protocol (e.g. `MyBox extends Container<int>`), the validator was
 * comparing the raw type-parameter name 'T' against the implementation's
 * return type 'int', producing a false-positive error:
 *
 *   "Protocol conformance error: method 'size' return type mismatch.
 *    'MyBox' declares 'int' but protocol 'Container' requires 'T'."
 *
 * The correct behaviour is to substitute the explicit argument (T → int)
 * and then compare.  The real-world trigger was the stdlib:
 *
 *   string extends Countable<int> { fn length(): int { … } }
 *
 * which previously emitted: "requires 'N'" even though <int> was supplied.
 *
 * Covers:
 *   ✓  Single explicit type arg — correct impl accepted (false-positive fix)
 *   ✓  Two explicit type args   — correct impl accepted
 *   ✓  Single explicit type arg — wrong return type still caught
 *   ✓  Two explicit type args   — wrong parameter type still caught
 *   ✓  Error messages show the substituted concrete type, not the raw param name
 *   ✓  Stdlib: string extends Countable<int> compiles without error
 *   ✓  Non-generic protocols: existing pass/fail behaviour is unaffected
 */

import { describe, it, expect } from 'vitest';
import { compileExpectError, compileToIR } from './helpers/cli.js';

// ── False-positive fix: valid programs must now be accepted ───────────────────

describe('generic protocol — valid: explicit single type arg', () => {
    it('compiles without error', () => {
        const result = compileToIR('generic_protocol_explicit_arg.code');
        expect(result.exitCode).toBe(0);
    });

    it('produces no protocol conformance errors', () => {
        const result = compileToIR('generic_protocol_explicit_arg.code');
        expect(result.stderr).not.toContain('Protocol conformance error');
    });

    it('produces no "return type mismatch" diagnostic', () => {
        const result = compileToIR('generic_protocol_explicit_arg.code');
        expect(result.stderr).not.toContain('return type mismatch');
    });
});

describe('generic protocol — valid: explicit two type args', () => {
    it('compiles without error', () => {
        const result = compileToIR('generic_protocol_multi_arg.code');
        expect(result.exitCode).toBe(0);
    });

    it('produces no protocol conformance errors', () => {
        const result = compileToIR('generic_protocol_multi_arg.code');
        expect(result.stderr).not.toContain('Protocol conformance error');
    });
});

// ── Real errors must still be caught ─────────────────────────────────────────

describe('generic protocol — invalid: wrong return type with explicit arg', () => {
    it('is rejected with exit code 1', () => {
        const result = compileExpectError('generic_protocol_wrong_return.code');
        expect(result.exitCode).toBe(1);
    });

    it('reports a protocol conformance error', () => {
        const { stderr } = compileExpectError('generic_protocol_wrong_return.code');
        expect(stderr).toContain('Protocol conformance error');
    });

    it('mentions "return type mismatch"', () => {
        const { stderr } = compileExpectError('generic_protocol_wrong_return.code');
        expect(stderr).toContain('return type mismatch');
    });

    it('shows the substituted concrete type "int" in the note, not raw param "T"', () => {
        const { stderr } = compileExpectError('generic_protocol_wrong_return.code');
        // The error must say "requires 'int'" (after substitution T→int),
        // NOT "requires 'T'" (the raw type-parameter name).
        expect(stderr).toContain("requires 'int'");
        expect(stderr).not.toContain("requires 'T'");
    });

    it('names the affected method in the error', () => {
        const { stderr } = compileExpectError('generic_protocol_wrong_return.code');
        expect(stderr).toContain("method 'size'");
    });

    it('help suggests the correct concrete return type', () => {
        const { stderr } = compileExpectError('generic_protocol_wrong_return.code');
        expect(stderr).toContain("'int'");
    });
});

describe('generic protocol — invalid: wrong parameter type with explicit args', () => {
    it('is rejected with exit code 1', () => {
        const result = compileExpectError('generic_protocol_wrong_param_type.code');
        expect(result.exitCode).toBe(1);
    });

    it('reports a parameter type mismatch', () => {
        const { stderr } = compileExpectError('generic_protocol_wrong_param_type.code');
        expect(stderr).toContain('parameter');
        expect(stderr).toContain('type mismatch');
    });

    it('shows the substituted concrete type "int", not the raw param "A"', () => {
        const { stderr } = compileExpectError('generic_protocol_wrong_param_type.code');
        expect(stderr).toContain("requires 'int'");
        expect(stderr).not.toContain("requires 'A'");
    });

    it('names the affected parameter in the error', () => {
        const { stderr } = compileExpectError('generic_protocol_wrong_param_type.code');
        expect(stderr).toContain("parameter 'x'");
    });
});

// ── Stdlib regression: string extends Countable<int> ─────────────────────────

describe('stdlib regression — string extends Countable<int>', () => {
    it('generics_displayable_countable.code compiles without any conformance error', () => {
        const result = compileToIR('generics_displayable_countable.code');
        expect(result.exitCode).toBe(0);
    });

    it('does not emit "requires \'N\'" (the old false-positive message)', () => {
        const result = compileToIR('generics_displayable_countable.code');
        expect(result.stderr).not.toContain("requires 'N'");
    });

    it('does not emit any "return type mismatch" on string.length()', () => {
        const result = compileToIR('generics_displayable_countable.code');
        expect(result.stderr).not.toContain('return type mismatch');
    });
});

// ── Non-generic protocol conformance is unaffected ────────────────────────────

describe('non-generic protocol — valid conformance still accepted', () => {
    it('protocol_conformance.code still compiles', () => {
        expect(compileToIR('protocol_conformance.code').exitCode).toBe(0);
    });
});

describe('non-generic protocol — invalid conformance still caught', () => {
    it('protocol_return_type_mismatch.code is still rejected', () => {
        const result = compileExpectError('protocol_return_type_mismatch.code');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Protocol conformance error');
        expect(result.stderr).toContain('return type mismatch');
    });

    it('protocol_missing_method.code is still rejected', () => {
        const result = compileExpectError('protocol_missing_method.code');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("does not implement required method");
    });
});
