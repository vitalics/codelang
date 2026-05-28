/**
 * Tests for the Error protocol, Stacktrace type, and shorthand field init.
 *
 * Covers:
 *   - `protocol Error extends Displayable { ... }` with fields + static/instance defaults
 *   - `Stacktrace` C runtime + stdlib
 *   - Protocol default `static fn new(name: string): Self` injected into conforming types
 *   - Override of `fn toString()` in a concrete conformer (`HttpError`)
 *   - Shorthand field init `name,` inside struct literals
 *   - `Self` keyword in protocol default body and return type
 *   - `Option<Stacktrace>` generic enum instantiation used as a struct field
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun }        from './helpers/cli.js';

function lines(): string[] {
    return compileAndRun('error_protocol.code').stdout.trim().split('\n');
}

// ── AppError (minimal conformer — uses all protocol defaults) ────────────────

describe('Error protocol — AppError (protocol defaults)', () => {
    it('compiles without error', () =>
        expect(compileAndRun('error_protocol.code').exitCode).toBe(0));

    it('AppError.new stores name correctly', () =>
        expect(lines()[0]).toBe('AppError'));
});

// ── HttpError (extra field, overridden toString) ──────────────────────────────

describe('Error protocol — HttpError (struct literal + override)', () => {
    it('HttpError struct literal stores name correctly', () =>
        expect(lines()[1]).toBe('NotFound'));

    it('HttpError struct literal stores statusCode correctly', () =>
        expect(lines()[2]).toBe('404'));

    it('HttpError overridden toString includes statusCode and name', () =>
        expect(lines()[3]).toBe('HttpError(404): NotFound'));
});

// ── Stacktrace field ──────────────────────────────────────────────────────────

describe('Error protocol — Stacktrace', () => {
    it('AppError stacktrace is Some (isSome returns true)', () =>
        // isSome() returns bool — printed as "true" or "false"
        expect(lines()[4]).toBe('true'));
});

// ── Full output ───────────────────────────────────────────────────────────────

describe('Error protocol — full output', () => {
    it('all output lines are correct', () =>
        expect(lines()).toEqual([
            'AppError',                   // e.name via protocol default new
            'NotFound',                   // http.name via struct literal
            '404',                        // http.statusCode via struct literal
            'HttpError(404): NotFound',   // http.toString() — overridden
            'true',                       // st.isSome() — bool true → "true"
        ]));
});
