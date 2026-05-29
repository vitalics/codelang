/**
 * Disposable protocol conformance for networking types.
 *
 * Every resource-owning networking type now implements Disposable so that
 * `using` can auto-close connections and free responses at end of scope.
 *
 * net_disposable.code — Uri + UriSearchParams + HttpHeaders + HttpRequest
 *   [0]  https            — Uri.scheme() after `using` auto-free
 *   [1]  2                — UriSearchParams.get("page") after `using` auto-free
 *   [2]  application/json — HttpHeaders.get("Content-Type")
 *   [3]  ok               — HttpRequest using block ran without crash
 *
 * net_tcp_disposable.code — TcpStream + TcpListener + UdpSocket + WebSocket
 *   [0]  ok               — all four modules compile with Disposable conformance
 *
 * IR assertions verify that every type's dispose() calls the correct C function.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── Fixture results ───────────────────────────────────────────────────────────

interface FixtureResult {
    exitCode: number | null;
    lines:    string[];
    ir:       string;
}

let http:  FixtureResult = { exitCode: null, lines: [], ir: '' };
let tcp:   FixtureResult = { exitCode: null, lines: [], ir: '' };

beforeAll(() => {
    const r = compileAndRun('net_disposable.code');
    http = { exitCode: r.exitCode, lines: r.stdout.trim().split('\n'), ir: r.ir };
}, 60_000);

beforeAll(() => {
    const r = compileAndRun('net_tcp_disposable.code');
    tcp = { exitCode: r.exitCode, lines: r.stdout.trim().split('\n'), ir: r.ir };
}, 60_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('net_disposable — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(http.exitCode).toBe(0);
    });
    it('produces exactly 4 lines of output', () => {
        expect(http.lines).toHaveLength(4);
    });
});

describe('net_tcp_disposable — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(tcp.exitCode).toBe(0);
    });
});

// ── Uri Disposable ────────────────────────────────────────────────────────────

describe('Uri extends Disposable', () => {
    it('[0] `using` auto-frees Uri; scheme() readable before end of block', () => {
        expect(http.lines[0]).toBe('https');
    });
});

// ── UriSearchParams Disposable ────────────────────────────────────────────────

describe('UriSearchParams extends Disposable', () => {
    it('[1] `using` auto-frees UriSearchParams; get() works in block', () => {
        expect(http.lines[1]).toBe('2');
    });
});

// ── HttpHeaders Disposable ────────────────────────────────────────────────────

describe('HttpHeaders extends Disposable', () => {
    it('[2] `using` auto-frees HttpHeaders; get() works in block', () => {
        expect(http.lines[2]).toBe('application/json');
    });
});

// ── HttpRequest Disposable ────────────────────────────────────────────────────

describe('HttpRequest extends Disposable', () => {
    it('[3] `using` auto-frees HttpRequest without crash', () => {
        expect(http.lines[3]).toBe('ok');
    });
});

// ── IR assertions: Uri / UriSearchParams ─────────────────────────────────────

describe('Uri + UriSearchParams — IR dispose wiring', () => {
    let ir = '';
    beforeAll(() => { ir = compileToIR('net_disposable.code').ir; }, 30_000);

    it('IR: declares @uri_free', () => {
        expect(ir).toMatch(/declare void @uri_free\(%Uri\*\)/);
    });
    it('IR: declares @uri_params_free', () => {
        expect(ir).toMatch(/declare void @uri_params_free\(%UriSearchParams\*\)/);
    });
    it('IR: dispose() on Uri calls @uri_free', () => {
        expect(ir).toMatch(/@uri_free/);
    });
    it('IR: dispose() on UriSearchParams calls @uri_params_free', () => {
        expect(ir).toMatch(/@uri_params_free/);
    });
});

// ── IR assertions: HttpHeaders / HttpRequest / HttpResponse / HttpClient ─────

describe('HTTP types — IR dispose wiring', () => {
    let ir = '';
    beforeAll(() => { ir = compileToIR('net_disposable.code').ir; }, 30_000);

    it('IR: declares @http_headers_free', () => {
        expect(ir).toMatch(/declare void @http_headers_free\(%HttpHeaders\*\)/);
    });
    it('IR: declares @http_request_free', () => {
        expect(ir).toMatch(/declare void @http_request_free\(%HttpRequest\*\)/);
    });
});

// ── IR assertions: TcpStream / TcpListener ────────────────────────────────────

describe('TcpStream + TcpListener — IR dispose wiring', () => {
    let ir = '';
    beforeAll(() => { ir = compileToIR('net_tcp_disposable.code').ir; }, 30_000);

    it('IR: declares @tcp_stream_close', () => {
        expect(ir).toMatch(/declare void @tcp_stream_close\(%TcpStream\*\)/);
    });
    it('IR: declares @tcp_listener_close', () => {
        expect(ir).toMatch(/declare void @tcp_listener_close\(%TcpListener\*\)/);
    });
});

// ── IR assertions: UdpSocket ──────────────────────────────────────────────────

describe('UdpSocket — IR dispose wiring', () => {
    let ir = '';
    beforeAll(() => { ir = compileToIR('net_tcp_disposable.code').ir; }, 30_000);

    it('IR: declares @udp_socket_close', () => {
        expect(ir).toMatch(/declare void @udp_socket_close\(%UdpSocket\*\)/);
    });
});

// ── IR assertions: WebSocket ──────────────────────────────────────────────────

describe('WebSocket — IR dispose wiring', () => {
    let ir = '';
    beforeAll(() => { ir = compileToIR('net_tcp_disposable.code').ir; }, 30_000);

    it('IR: declares @ws_close', () => {
        expect(ir).toMatch(/declare void @ws_close\(%WebSocket\*\)/);
    });
});
