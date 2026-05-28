/**
 * Tests for the `switch_import!` compile-time conditional import.
 *
 * Covers:
 *  1. Grammar — SwitchImport parses and compiles successfully
 *  2. Runtime — correct branch is selected based on compile.arch() / compile.os()
 *  3. Else branch — fallback when no arm matches
 *  4. IR structure — selected module's functions appear in the IR
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';
import * as os from 'node:os';

// ── Fixture names ─────────────────────────────────────────────────────────────

const ARCH  = 'switch_import_arch.code';
const OS    = 'switch_import_os.code';
const ELSE  = 'switch_import_else.code';

// ── Helpers ───────────────────────────────────────────────────────────────────

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// ── Expected backend for this host ───────────────────────────────────────────

/** Map Node.js process.arch to the expected backend name. */
function expectedArch(): string {
    const a = process.arch;
    if (a === 'arm64')           return 'arm64-backend';
    if (a === 'x64' || a === 'x86_64') return 'x64-backend';
    return 'generic-backend';
}

/** Map Node.js process.platform to the expected backend name. */
function expectedOs(): string {
    const p = process.platform;
    if (p === 'darwin')  return 'arm64-backend';
    if (p === 'linux')   return 'x64-backend';
    return 'generic-backend';
}

// =============================================================================
// 1. Grammar — compile.arch() dispatch
// =============================================================================

describe('switch_import! — compile.arch() dispatch', () => {

    it('compiles and exits with code 0', () => {
        const { exitCode } = compileAndRun(ARCH);
        expect(exitCode).toBe(0);
    });

    it('selects the correct backend for this architecture', () => {
        const { stdout } = compileAndRun(ARCH);
        expect(lines(stdout)[0]).toBe(expectedArch());
    });

    it('IR: selected backend function is emitted', () => {
        const { ir } = compileToIR(ARCH);
        // The platformName function from the selected backend must be in the IR
        expect(ir).toMatch(/define.*@platformName/);
    });
});

// =============================================================================
// 2. Grammar — compile.os() dispatch
// =============================================================================

describe('switch_import! — compile.os() dispatch', () => {

    it('compiles and exits with code 0', () => {
        const { exitCode } = compileAndRun(OS);
        expect(exitCode).toBe(0);
    });

    it('selects the correct backend for this OS', () => {
        const { stdout } = compileAndRun(OS);
        expect(lines(stdout)[0]).toBe(expectedOs());
    });
});

// =============================================================================
// 3. Else branch fallback
// =============================================================================

describe('switch_import! — else branch fallback', () => {

    it('compiles and exits with code 0', () => {
        const { exitCode } = compileAndRun(ELSE);
        expect(exitCode).toBe(0);
    });

    it('uses the else branch when no arm matches', () => {
        const { stdout } = compileAndRun(ELSE);
        // impossible_arch_xyz never matches → else → generic-backend
        expect(lines(stdout)[0]).toBe('generic-backend');
    });

    it('IR: generic backend platformName is emitted', () => {
        const { ir } = compileToIR(ELSE);
        expect(ir).toMatch(/define.*@platformName/);
    });
});
