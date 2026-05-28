/**
 * Shared helpers for integration tests.
 *
 * All compilation is done via the real `codelang` CLI so the tests exercise
 * the complete pipeline (parse → validate → IR → clang → native binary).
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/** Absolute path to the repository root */
export const ROOT = path.resolve(__dirname, '../..');

/** Absolute path to the CLI entry-point */
export const CLI = path.join(ROOT, 'bin', 'codelang.js');

/** Fixture directories */
export const FIXTURES = {
    valid:   path.join(__dirname, '..', 'fixtures', 'valid'),
    invalid: path.join(__dirname, '..', 'fixtures', 'invalid'),
} as const;

// ── Result type ───────────────────────────────────────────────────────────────

export interface CliResult {
    exitCode: number | null;
    stdout:   string;
    stderr:   string;
}

// ── Low-level runner ──────────────────────────────────────────────────────────

export function runCLI(args: string[]): CliResult {
    const result = spawnSync('node', [CLI, ...args], {
        encoding: 'utf-8',
        // 120 s — allow extra time when other test forks are also compiling
        timeout: 120_000,
    });
    return {
        exitCode: result.status ?? null,
        stdout:   result.stdout ?? '',
        stderr:   result.stderr ?? '',
    };
}

// ── High-level helpers ────────────────────────────────────────────────────────

/**
 * Compile a fixture file to LLVM IR only.
 * Returns the IR text on success; empty string on failure.
 */
export function compileToIR(
    name: string,
    dir: keyof typeof FIXTURES = 'valid',
): CliResult & { ir: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelang-test-'));
    try {
        const fixturePath = path.join(FIXTURES[dir], name);
        const result = runCLI(['compile', fixturePath, '--ir', '--no-cache', '-d', tmpDir]);

        const baseName = path.basename(name, '.code');
        const llFile   = path.join(tmpDir, `${baseName}.ll`);
        const ir       = fs.existsSync(llFile) ? fs.readFileSync(llFile, 'utf-8') : '';

        return { ...result, ir };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Compile a valid fixture to a native binary, then run it and capture stdout.
 * The CLI always saves the LLVM IR as an intermediate (.ll) file even during
 * full compilation, so this function also reads it back — callers get both
 * runtime output and IR text in a single compile pass.
 *
 * Compilation artifacts are written to a temporary directory that is
 * cleaned up automatically.
 */
export function compileAndRun(name: string): CliResult & { ir: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelang-test-'));
    try {
        const fixturePath = path.join(FIXTURES.valid, name);
        const baseName    = path.basename(name, '.code');

        // Step 1: compile → binary (the CLI also saves baseName.ll as a
        //         side-effect of code generation, so we can read it below)
        const compileResult = runCLI(['compile', fixturePath, '--no-cache', '-d', tmpDir]);

        // Read the IR that was saved alongside the binary
        const llFile = path.join(tmpDir, `${baseName}.ll`);
        const ir     = fs.existsSync(llFile) ? fs.readFileSync(llFile, 'utf-8') : '';

        if (compileResult.exitCode !== 0) return { ...compileResult, ir };

        // Step 2: run the native binary and capture its output
        const exeFile   = path.join(tmpDir, baseName);
        const runResult = spawnSync(exeFile, [], { encoding: 'utf-8', timeout: 5_000 });

        return {
            exitCode: runResult.status ?? null,
            stdout:   runResult.stdout ?? '',
            stderr:   runResult.stderr ?? '',
            ir,
        };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Compile a fixture that is expected to fail validation.
 * Returns the combined error text and exit code for assertions.
 */
export function compileExpectError(name: string): CliResult {
    const fixturePath = path.join(FIXTURES.invalid, name);
    return runCLI(['compile', fixturePath, '--no-cache']);
}
