/**
 * Rust-style diagnostic formatter for CodeLang.
 *
 * Produces output like:
 *
 *   error: Protocol conformance error: method 'lol' return type mismatch
 *     --> 01_simple.code:11:3
 *      |
 *   10 |     fn lol(): int {
 *   11 |     ^^^^^^^^^^^^^^
 *      |
 *      = note: 'Number' declares 'int' but protocol 'Lolable' requires 'void'
 *      = help: Change the return type of 'lol' from 'int' to 'void'
 *
 *   aborting due to 1 error
 */

import chalk from 'chalk';
import * as path from 'node:path';
import type { Diagnostic } from 'vscode-languageserver-types';

// ── Structured extra data attached to diagnostics by the validator ────────────

export interface CodeLangDiagnosticData {
    /** Secondary explanation line, shown as `= note: ...` */
    note?: string;
    /** Fix suggestion, shown as `= help: ...` in green */
    help?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Left-pad a number to `width` characters. */
function padNum(n: number, width: number): string {
    return String(n).padStart(width);
}

/** Replace tabs with 4 spaces so column arithmetic stays consistent. */
function normalizeLine(line: string): string {
    return line.replace(/\t/g, '    ');
}

/**
 * Render a single diagnostic in Rust style.
 */
function renderOne(diag: Diagnostic, sourceLines: string[], fileName: string): string {
    const startLine = diag.range.start.line;        // 0-indexed
    const startChar = diag.range.start.character;   // 0-indexed
    const endLine   = diag.range.end.line;          // 0-indexed
    const endChar   = diag.range.end.character;     // 0-indexed

    const displayLine = startLine + 1;  // 1-indexed for display
    const displayCol  = startChar + 1;  // 1-indexed for display

    // Gutter width: at least 2, enough for the highest line number we show
    const maxLineNum = displayLine;
    const gutterW    = Math.max(2, String(maxLineNum).length);
    const pad        = ' '.repeat(gutterW);

    const baseName = path.basename(fileName);

    // Source lines
    const prevSrc  = startLine > 0 ? normalizeLine(sourceLines[startLine - 1] ?? '') : null;
    const errorSrc = normalizeLine(sourceLines[startLine] ?? '');

    // Underline: from startChar to endChar on the same line; minimum 1 caret
    const uStart = startChar;
    const uEnd   = (endLine === startLine)
        ? Math.min(endChar, errorSrc.length)
        : errorSrc.length;
    const uLen   = Math.max(1, uEnd - uStart);
    const carets = ' '.repeat(uStart) + chalk.red.bold('^'.repeat(uLen));

    // Extra data from the validator
    const data = (diag as unknown as { data?: CodeLangDiagnosticData }).data ?? {};
    const note = data.note;
    const help = data.help;

    const out: string[] = [];

    // ── Header ────────────────────────────────────────────────────────────────
    out.push(
        chalk.red.bold('error') +
        chalk.bold(': ' + diag.message)
    );

    // ── Location arrow ────────────────────────────────────────────────────────
    out.push(
        chalk.cyan(`${pad}  --> `) +
        `${baseName}:${displayLine}:${displayCol}`
    );

    // ── Gutter blank ─────────────────────────────────────────────────────────
    out.push(chalk.cyan(`${pad}   |`));

    // ── Context line (one line above) — shown only if non-empty ──────────────
    if (prevSrc !== null && prevSrc.trim().length > 0) {
        const prevLineNum = padNum(startLine, gutterW);
        out.push(chalk.cyan(`${prevLineNum}   | `) + chalk.dim(prevSrc));
    }

    // ── Error line ────────────────────────────────────────────────────────────
    const errLineNum = padNum(displayLine, gutterW);
    out.push(chalk.cyan(`${errLineNum}   | `) + errorSrc);

    // ── Caret underline ───────────────────────────────────────────────────────
    out.push(chalk.cyan(`${pad}   | `) + carets);

    // ── Closing gutter blank ──────────────────────────────────────────────────
    out.push(chalk.cyan(`${pad}   |`));

    // ── Note ──────────────────────────────────────────────────────────────────
    if (note) {
        out.push(
            chalk.cyan(`${pad}   = `) +
            chalk.bold('note: ') +
            note
        );
    }

    // ── Help / fix suggestion ─────────────────────────────────────────────────
    if (help) {
        out.push(
            chalk.cyan(`${pad}   = `) +
            chalk.bold('help: ') +
            chalk.green(help)
        );
    }

    return out.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Format a list of compiler diagnostics in Rust-style.
 *
 * @param errors      Array of Langium/LSP Diagnostic objects (severity === 1)
 * @param fileName    Absolute or relative path to the source file
 * @param sourceText  Full text of the source file (from document.textDocument.getText())
 * @returns           Ready-to-print string (includes trailing `aborting` line)
 */
export function formatDiagnostics(
    errors: Diagnostic[],
    fileName: string,
    sourceText: string,
): string {
    const sourceLines = sourceText.split('\n');
    const rendered    = errors.map(d => renderOne(d, sourceLines, fileName));
    const count       = errors.length;
    const footer      = chalk.red.bold(
        `\naborting due to ${count} error${count === 1 ? '' : 's'}`
    );
    return rendered.join('\n\n') + '\n' + footer;
}

/**
 * Format a single IR-generator error (no source location available).
 * Used in main.ts for errors thrown by the IR emitter.
 */
export function formatIRError(message: string): string {
    return (
        chalk.red.bold('error') + chalk.bold(': ' + message) +
        '\n' +
        chalk.red.bold('\naborting due to 1 error')
    );
}
