/**
 * Number / BigInt tests.
 *
 * Verifies that the dynamic Number type automatically promotes from
 * int64 to arbitrary-precision BigInt when arithmetic overflows.
 * 9999999999 × 9999999999 = 99999999980000000001, which exceeds
 * INT64_MAX (≈ 9.2 × 10¹⁸) and must be represented as BigInt.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

describe('Number — BigInt auto-promotion on overflow', () => {
    it('9999999999 * 9999999999 = 99999999980000000001 (exceeds int64)', () => {
        const { exitCode, stdout } = compileAndRun('bigint_overflow.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('99999999980000000001\n');
    });
});
