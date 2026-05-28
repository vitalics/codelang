/**
 * std module integration tests
 *
 * Compiles fixture programs that import from stdlib/std/* and checks runtime output.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

describe('std/string — character access', () => {
    it('length, charAt, at, charCodeAt, fromCharCode', () => {
        const { exitCode, stdout } = compileAndRun('std_string_access.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('5\ne\no\n65\nA\n');
    });
});

describe('std/string — search', () => {
    it('indexOf, lastIndexOf, includes, startsWith, endsWith', () => {
        const { exitCode, stdout } = compileAndRun('std_string_search.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('6\n12\ntrue\ntrue\ntrue\n');
    });
});

describe('std/string — transform', () => {
    it('toUpperCase, toLowerCase, trim, slice, repeat, replace, concat, pad', () => {
        const { exitCode, stdout } = compileAndRun('std_string_transform.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('HELLO\nworld\nhi\nworld\nababab\nhello there\nfoobar\n005\n500\n');
    });
});

describe('std/string — edge cases', () => {
    it('length(""), at(-1), empty slice, zero repeat, indexOf, concat', () => {
        const { exitCode, stdout } = compileAndRun('std_string_edge.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('0\no\n\n\n0\nhello\n');
    });
});
