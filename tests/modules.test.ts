/**
 * Import / export tests
 *
 * Tests the full import pipeline:
 *
 *   Bare import:
 *     import "./greetings"     ← all exports in scope directly
 *     greet()                  ← calls @greet
 *
 *   Namespace import:
 *     const g = import "./greetings"
 *     g.greet()                ← also calls @greet
 *
 *   Error cases:
 *     Missing file, import cycles
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun, compileExpectError, FIXTURES } from './helpers/cli.js';
import * as path from 'node:path';
import * as os   from 'node:os';
import * as fs   from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CLI } from './helpers/cli.js';

// ── IR-level checks ───────────────────────────────────────────────────────────

describe('modules — IR generation', () => {
    it('single-file programs still compile (regression guard)', () => {
        const { exitCode, ir } = compileToIR('hello.code');
        expect(exitCode).toBe(0);
        expect(ir).toContain('define i32 @main');
    });

    it('exported functions get public linkage (define, not define private)', () => {
        const { exitCode, ir } = compileToIR('greetings.code');
        expect(exitCode).toBe(0);
        expect(ir).toContain('define void @greet()');
        expect(ir).toContain('define void @farewell()');
        expect(ir).not.toContain('define private void @greet');
    });

    it('bare import: multi-module IR contains functions from all modules', () => {
        const { exitCode, ir } = compileToIR('greetings_main.code');
        expect(exitCode).toBe(0);
        expect(ir).toContain('define void @greet()');
        expect(ir).toContain('define void @farewell()');
        expect(ir).toContain('define i32 @main()');
    });

    it('bare import: main calls @greet and @farewell directly', () => {
        const { exitCode, ir } = compileToIR('greetings_main.code');
        expect(exitCode).toBe(0);
        expect(ir).toMatch(/call void @greet\(\)/);
        expect(ir).toMatch(/call void @farewell\(\)/);
    });

    it('namespace import: g.greet() emits call void @greet()', () => {
        const { exitCode, ir } = compileToIR('import_alias.code');
        expect(exitCode).toBe(0);
        // The call must target @greet (the real IR symbol)
        expect(ir).toMatch(/call void @greet\(\)/);
    });

    it('string constants from imported modules are deduplicated globally', () => {
        const { ir } = compileToIR('greetings_main.code');
        // Each distinct string literal must appear exactly once in the global constants,
        // even though both greet() and farewell() live in separate source modules.
        const helloCount   = (ir.match(/Hello from imported module/g) ?? []).length;
        const goodbyeCount = (ir.match(/Goodbye from imported module/g) ?? []).length;
        expect(helloCount).toBe(2);    // one @.str.N declaration + one @.raw.N (w/o \n)
        expect(goodbyeCount).toBe(2);  // same
    });
});

// ── Runtime output ────────────────────────────────────────────────────────────

describe('modules — runtime behavior', () => {
    it('bare import: imported functions execute in call order', () => {
        const { exitCode, stdout } = compileAndRun('greetings_main.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe(
            'Hello from imported module!\n' +
            'Goodbye from imported module!\n',
        );
    });

    it('namespace import: g.greet() produces the same output as greet()', () => {
        const { exitCode, stdout } = compileAndRun('import_alias.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('Hello from imported module!\n');
    });
});

// ── Error cases (module resolver) ────────────────────────────────────────────

describe('modules — module resolution errors', () => {
    it('fails with a clear message when the imported file does not exist', () => {
        const result = compileExpectError('import_missing_file.code');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('does_not_exist');
    });

    it('detects and reports import cycles', () => {
        const result = compileExpectError('cycle_a.code');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/[Cc]ircular|[Cc]ycl/);
        expect(result.stderr).toContain('cycle_a');
        expect(result.stderr).toContain('cycle_b');
    });
});

// ── Round-trip: compile from a temp dir ──────────────────────────────────────

describe('modules — temp-dir round-trip', () => {
    it('bare import: compiles a two-file project with a relative import', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelang-modtest-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'utils.code'), [
                'export fn hello() {',
                '  print("from utils");',
                '}',
            ].join('\n'));

            fs.writeFileSync(path.join(tmpDir, 'main.code'), [
                'import "./utils";',
                'fn main() {',
                '  hello();',
                '}',
            ].join('\n'));

            const buildDir = path.join(tmpDir, 'out');
            fs.mkdirSync(buildDir);

            const compileResult = spawnSync(
                'node',
                [CLI, 'compile', path.join(tmpDir, 'main.code'), '--no-cache', '-d', buildDir],
                { encoding: 'utf-8', timeout: 30_000 },
            );
            expect(compileResult.status).toBe(0);

            const exeFile = path.join(buildDir, 'main');
            const runResult = spawnSync(exeFile, [], { encoding: 'utf-8', timeout: 5_000 });
            expect(runResult.status).toBe(0);
            expect(runResult.stdout).toBe('from utils\n');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('namespace import: const mod = import "./utils"; mod.hello()', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelang-nstest-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'utils.code'), [
                'export fn hello() {',
                '  print("ns hello");',
                '}',
            ].join('\n'));

            fs.writeFileSync(path.join(tmpDir, 'main.code'), [
                'const utils = import "./utils";',
                'fn main() {',
                '  utils.hello();',
                '}',
            ].join('\n'));

            const buildDir = path.join(tmpDir, 'out');
            fs.mkdirSync(buildDir);

            const compileResult = spawnSync(
                'node',
                [CLI, 'compile', path.join(tmpDir, 'main.code'), '--no-cache', '-d', buildDir],
                { encoding: 'utf-8', timeout: 30_000 },
            );
            expect(compileResult.status).toBe(0);

            const exeFile = path.join(buildDir, 'main');
            const runResult = spawnSync(exeFile, [], { encoding: 'utf-8', timeout: 5_000 });
            expect(runResult.status).toBe(0);
            expect(runResult.stdout).toBe('ns hello\n');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
