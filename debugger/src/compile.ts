/**
 * debugger/src/compile.ts
 *
 * Compile a .code source file with debug symbols (-g / --debug) and
 * return the path of the resulting binary.
 *
 * Uses the `codelang` CLI that lives alongside this adapter.
 */

import { spawnSync } from 'node:child_process';
import * as path      from 'node:path';
import * as fs        from 'node:fs';
import * as os        from 'node:os';

// debugger/out/compile.js → go up one level to reach debugger/, then one more to reach project root.
// File hierarchy: <project>/debugger/out/compile.js
const DEBUGGER_DIR = path.resolve(new URL('.', import.meta.url).pathname, '..'); // debugger/out → debugger/
const CODELANG     = path.resolve(DEBUGGER_DIR, '..', 'bin', 'codelang.js');    // debugger/ → project root

export interface CompileResult {
    /** Absolute path to the compiled binary ready to be debugged. */
    binaryPath: string;
    /** Temporary directory that was created (should be deleted on exit). */
    tmpDir: string;
}

/**
 * Compile `sourceFile` with DWARF debug info.
 *
 * @param sourceFile - Absolute path to the .code entry point.
 * @param env        - Optional extra environment variables (e.g. from launch config).
 */
export async function compileForDebug(
    sourceFile: string,
    env?: Record<string, string>,
): Promise<CompileResult> {
    if (!fs.existsSync(sourceFile)) {
        throw new Error(`Source file not found: ${sourceFile}`);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelang-dap-'));

    const result = spawnSync(
        'node',
        [CODELANG, 'compile', sourceFile, '--debug', '--no-cache', '-d', tmpDir],
        {
            encoding: 'utf-8',
            stdio:    'pipe',
            env: { ...process.env, ...env },
        },
    );

    if (result.status !== 0) {
        const err = (result.stderr ?? '') + (result.stdout ?? '');
        // Clean up on failure
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`CodeLang compilation failed:\n${err.trim()}`);
    }

    // The binary name matches the source basename without extension
    const baseName = path.basename(sourceFile, path.extname(sourceFile));
    const exeExt   = process.platform === 'win32' ? '.exe' : '';
    const binaryPath = path.join(tmpDir, baseName + exeExt);

    if (!fs.existsSync(binaryPath)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`Compilation succeeded but binary not found at: ${binaryPath}`);
    }

    return { binaryPath, tmpDir };
}
