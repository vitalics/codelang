/**
 * stdlib/network/server — Express/Elysia-style HTTP server tests.
 *
 * net_server.code — starts an HttpServer on port 18081, registers five routes,
 * makes real HTTP requests via HttpClient, and asserts responses.
 *
 * (6 expected output lines):
 *   [0]  200               — GET /hello → status code
 *   [1]  world             — GET /hello → body
 *   [2]  express           — GET /greet/:name → param capture
 *   [3]  hello post        — POST /echo → request body passthrough
 *   [4]  42                — GET /num/:n → numeric param capture
 *   [5]  application/json  — GET /json  → Content-Type response header
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
    const r = compileAndRun('net_server.code');
    res = {
        exitCode: r.exitCode,
        lines:    r.stdout.trim().split('\n'),
        ir:       r.ir,
    };
}, 60_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('net_server — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(res.exitCode).toBe(0);
    });
    it('produces exactly 6 lines of output', () => {
        expect(res.lines).toHaveLength(6);
    });
});

// ── Static route ──────────────────────────────────────────────────────────────

describe('HttpServer — GET /hello (static route)', () => {
    it('[0] responds with HTTP 200', () => {
        expect(res.lines[0]).toBe('200');
    });
    it('[1] body is "world"', () => {
        expect(res.lines[1]).toBe('world');
    });
});

// ── Route param capture ───────────────────────────────────────────────────────

describe('HttpServer — GET /greet/:name (param capture)', () => {
    it('[2] req.param("name") returns the captured path segment', () => {
        expect(res.lines[2]).toBe('express');
    });
});

// ── POST + body passthrough ───────────────────────────────────────────────────

describe('HttpServer — POST /echo (request body passthrough)', () => {
    it('[3] req.body() returns the raw POST body', () => {
        expect(res.lines[3]).toBe('hello post');
    });
});

// ── Numeric param capture ─────────────────────────────────────────────────────

describe('HttpServer — GET /num/:n (numeric param capture)', () => {
    it('[4] req.param("n") returns the numeric segment as a string', () => {
        expect(res.lines[4]).toBe('42');
    });
});

// ── JSON response + Content-Type header ──────────────────────────────────────

describe('HttpServer — GET /json (JSON response + Content-Type header)', () => {
    it('[5] Content-Type response header is "application/json"', () => {
        expect(res.lines[5]).toBe('application/json');
    });
});

// ── IR declarations ───────────────────────────────────────────────────────────

describe('net_server — IR declarations', () => {
    let ir = '';

    beforeAll(() => {
        const r = compileToIR('net_server.code');
        ir = r.ir;
    }, 30_000);

    it('IR: declares @server_new', () => {
        expect(ir).toMatch(/declare i8\* @server_new\(\)/);
    });
    it('IR: declares @server_add_route', () => {
        expect(ir).toMatch(/declare void @server_add_route\(i8\*, i8\*, i8\*, \{ i8\*, i8\* \}\)/);
    });
    it('IR: declares @server_listen_async', () => {
        expect(ir).toMatch(/declare void @server_listen_async\(i8\*, i32\)/);
    });
    it('IR: declares @server_stop', () => {
        expect(ir).toMatch(/declare void @server_stop\(i8\*\)/);
    });
    it('IR: declares @resp_ok', () => {
        expect(ir).toMatch(/declare i8\* @resp_ok\(i8\*\)/);
    });
    it('IR: declares @resp_json', () => {
        expect(ir).toMatch(/declare i8\* @resp_json\(i8\*\)/);
    });
    it('IR: declares @sr_param', () => {
        expect(ir).toMatch(/declare i8\* @sr_param\(i8\*, i8\*\)/);
    });
    it('IR: declares @sr_body', () => {
        expect(ir).toMatch(/declare i8\* @sr_body\(i8\*\)/);
    });
});
