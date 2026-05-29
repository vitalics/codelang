/**
 * debugger/src/platform.ts
 *
 * Locate the best available native debugger on the current platform:
 *   macOS  — lldb-dap (LLVM 17+) or lldb-vscode (LLVM ≤ 16 alias)
 *   Linux  — lldb-dap, then gdb --interpreter=dap (GDB 14+)
 *   Windows — not yet supported; falls back gracefully
 */

import { existsSync } from 'node:fs';
import { spawnSync  } from 'node:child_process';
import * as path      from 'node:path';
import * as os        from 'node:os';

export type DebugBackend = 'lldb' | 'gdb';

export interface DebuggerInfo {
    backend:    DebugBackend;
    executable: string;
    /** extra args that must always be prepended */
    extraArgs?: string[];
}

// ── Known lldb-dap / lldb-vscode install paths ────────────────────────────────

const LLDB_DAP_CANDIDATES: string[] = [
    // Homebrew LLVM (latest, then numbered)
    '/opt/homebrew/opt/llvm/bin/lldb-dap',
    '/opt/homebrew/opt/llvm@21/bin/lldb-dap',
    '/opt/homebrew/opt/llvm@20/bin/lldb-dap',
    '/opt/homebrew/opt/llvm@19/bin/lldb-dap',
    '/opt/homebrew/opt/llvm@18/bin/lldb-dap',
    '/opt/homebrew/opt/llvm@17/bin/lldb-dap',
    // Older alias used before LLVM 17
    '/opt/homebrew/opt/llvm@16/bin/lldb-vscode',
    '/opt/homebrew/opt/llvm@15/bin/lldb-vscode',
    '/opt/homebrew/opt/llvm@14/bin/lldb-vscode',
    // Linux package manager paths
    '/usr/bin/lldb-dap',
    '/usr/bin/lldb-vscode',
    '/usr/local/bin/lldb-dap',
    '/usr/local/bin/lldb-vscode',
    // Conda / venv environments
    ...(process.env['CONDA_PREFIX'] ? [path.join(process.env['CONDA_PREFIX'], 'bin', 'lldb-dap')] : []),
];

const GDB_CANDIDATES: string[] = [
    '/usr/bin/gdb',
    '/usr/local/bin/gdb',
    '/opt/homebrew/bin/gdb',
];

/** Try to resolve a binary on PATH (returns full path or null). */
function which(name: string): string | null {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0].trim();
    return null;
}

/** Check if gdb supports --interpreter=dap (GDB 14+). */
function gdbSupportsDap(gdb: string): boolean {
    const r = spawnSync(gdb, ['--version'], { encoding: 'utf-8' });
    if (r.status !== 0) return false;
    // "GNU gdb (GDB) 14.x" or similar
    const m = r.stdout.match(/GNU gdb.*?(\d+)\./);
    return m !== null && parseInt(m[1], 10) >= 14;
}

/**
 * Locate the best native debugger for this platform.
 * Throws if nothing is found.
 */
export function findDebugger(): DebuggerInfo {
    // 1. Try lldb-dap candidates in order
    for (const candidate of LLDB_DAP_CANDIDATES) {
        if (existsSync(candidate)) {
            return { backend: 'lldb', executable: candidate };
        }
    }

    // 2. Try `lldb-dap` / `lldb-vscode` on PATH
    const lldbDap = which('lldb-dap') ?? which('lldb-vscode');
    if (lldbDap) return { backend: 'lldb', executable: lldbDap };

    // 3. Try gdb with DAP support (Linux/Windows)
    if (os.platform() !== 'darwin') {
        for (const candidate of GDB_CANDIDATES) {
            if (existsSync(candidate) && gdbSupportsDap(candidate)) {
                return { backend: 'gdb', executable: candidate, extraArgs: ['--interpreter=dap'] };
            }
        }
        const gdb = which('gdb');
        if (gdb && gdbSupportsDap(gdb)) {
            return { backend: 'gdb', executable: gdb, extraArgs: ['--interpreter=dap'] };
        }
    }

    throw new Error(
        'No supported debugger found.\n' +
        '  macOS : brew install llvm   (provides lldb-dap)\n' +
        '  Linux : sudo apt install lldb  OR  sudo apt install gdb  (GDB 14+)\n'
    );
}
