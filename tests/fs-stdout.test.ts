/**
 * stdlib/fs — File.stdout() / File.stderr() / FileReadStream.pipeTo() tests.
 *
 * fs_stdout.code — wraps process stdout/stderr as FileWriteStream + pipe
 * (3 expected stdout lines):
 *   [0]  hello stdout  — File.stdout().writeln()
 *   [1]  line two      — File.stdout().writeln() (same stream, second call)
 *   [2]  piped line    — File.createReadStream(…).pipeTo(File.stdout())
 *
 * stderr output ("debug: ok") is intentionally not checked here.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── Shared fixture result ─────────────────────────────────────────────────────

interface FixtureResult {
    exitCode: number | null;
    lines:    string[];
    ir:       string;
}

let res: FixtureResult = { exitCode: null, lines: [], ir: '' };

beforeAll(() => {
    const r = compileAndRun('fs_stdout.code');
    res = {
        exitCode: r.exitCode,
        lines:    r.stdout.trim().split('\n'),
        ir:       r.ir,
    };
}, 60_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('fs_stdout — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(res.exitCode).toBe(0);
    });
    it('produces exactly 3 lines of stdout', () => {
        expect(res.lines).toHaveLength(3);
    });
});

// ── File.stdout() as FileWriteStream ─────────────────────────────────────────

describe('File.stdout() — non-owning FileWriteStream', () => {
    it('[0] writeln() via File.stdout() appears on stdout', () => {
        expect(res.lines[0]).toBe('hello stdout');
    });
    it('[1] second writeln() via the same stream appears on stdout', () => {
        expect(res.lines[1]).toBe('line two');
    });
});

// ── FileReadStream.pipeTo ─────────────────────────────────────────────────────

describe('FileReadStream.pipeTo — pipe file to stdout', () => {
    it('[2] piped file contents appear on stdout', () => {
        expect(res.lines[2]).toBe('piped line');
    });
});

// ── IR declarations ───────────────────────────────────────────────────────────

describe('fs_stdout — IR declarations', () => {
    let ir = '';

    beforeAll(() => {
        const r = compileToIR('fs_stdout.code');
        ir = r.ir;
    }, 30_000);

    it('IR: declares @fws_stdout', () => {
        expect(ir).toMatch(/declare i8\* @fws_stdout\(\)/);
    });
    it('IR: declares @fws_stderr', () => {
        expect(ir).toMatch(/declare i8\* @fws_stderr\(\)/);
    });
    it('IR: declares @frs_pipe_to', () => {
        expect(ir).toMatch(/declare void @frs_pipe_to\(i8\*, i8\*\)/);
    });
});
