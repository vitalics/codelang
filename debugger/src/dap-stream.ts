/**
 * debugger/src/dap-stream.ts
 *
 * Minimal DAP (Debug Adapter Protocol) message framing.
 *
 * Each DAP message is sent as:
 *   Content-Length: <byte-length>\r\n\r\n<JSON body>
 *
 * This module provides:
 *   DapReader — reads a Readable stream and emits 'message' events with parsed JSON
 *   sendDap   — serialises and writes a DAP message to a Writable
 */

import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

// ── DapReader ─────────────────────────────────────────────────────────────────

export class DapReader extends EventEmitter {
    private buf = Buffer.alloc(0);

    constructor(readable: Readable) {
        super();
        readable.on('data', (chunk: Buffer | string) => {
            this.buf = Buffer.concat([this.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
            this.process();
        });
        readable.on('end',   () => this.emit('end'));
        readable.on('error', (err) => this.emit('error', err));
    }

    private process(): void {
        while (true) {
            // Find the header separator
            const sep = this.buf.indexOf('\r\n\r\n');
            if (sep === -1) break;

            const header = this.buf.slice(0, sep).toString('utf-8');
            const m = header.match(/Content-Length:\s*(\d+)/i);
            if (!m) { this.buf = this.buf.slice(sep + 4); continue; }

            const len  = parseInt(m[1], 10);
            const body = sep + 4 + len;
            if (this.buf.length < body) break;  // wait for more data

            const json = this.buf.slice(sep + 4, body).toString('utf-8');
            this.buf   = this.buf.slice(body);

            try {
                this.emit('message', JSON.parse(json) as DapMessage);
            } catch {
                // malformed JSON — skip
            }
        }
    }
}

// ── sendDap ───────────────────────────────────────────────────────────────────

export function sendDap(writable: Writable, msg: DapMessage): void {
    const body = JSON.stringify(msg);
    const len  = Buffer.byteLength(body, 'utf-8');
    writable.write(`Content-Length: ${len}\r\n\r\n${body}`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DapMessage {
    seq:  number;
    type: 'request' | 'response' | 'event';
    [key: string]: unknown;
}

export interface DapRequest extends DapMessage {
    type:      'request';
    command:   string;
    arguments: Record<string, unknown>;
}

export interface DapResponse extends DapMessage {
    type:        'response';
    request_seq: number;
    success:     boolean;
    command:     string;
    body?:       Record<string, unknown>;
    message?:    string;
}

export interface DapEvent extends DapMessage {
    type:  'event';
    event: string;
    body?: Record<string, unknown>;
}
