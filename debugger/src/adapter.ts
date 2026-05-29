/**
 * debugger/src/adapter.ts
 *
 * CodeLang DAP proxy adapter.
 *
 * Flow:
 *   Editor  ──DAP──►  this adapter  ──DAP──►  lldb-dap / gdb
 *                         │
 *                    on `launch`:
 *                      1. compile .code file with --debug
 *                      2. inject compiled binary path into the request
 *                      3. forward to native debugger
 *
 * Everything else is forwarded verbatim so we get full lldb/gdb capabilities
 * (breakpoints, step, variables, stack, evaluate, etc.) for free.
 */

import { spawn }       from 'node:child_process';
import { rmSync }       from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { DapReader, sendDap } from './dap-stream.js';
import type { DapMessage, DapRequest, DapResponse } from './dap-stream.js';
import { findDebugger }  from './platform.js';
import { compileForDebug } from './compile.js';

// ── Adapter ───────────────────────────────────────────────────────────────────

export class CodeLangDapAdapter {
    /** Sequential counter for messages we synthesise (uses negative range to avoid collisions). */
    private seq = 1;

    /** Directories to clean up when the session ends. */
    private tmpDirs: string[] = [];

    /** The native debugger process (lldb-dap / gdb). */
    private dbgProc: ChildProcessWithoutNullStreams | null = null;

    /** Reader for messages coming from the native debugger. */
    private dbgReader: DapReader | null = null;

    /** Queued messages waiting for the native debugger to start. */
    private pendingToDbg: DapMessage[] = [];

    /** Whether the native debugger process is ready for messages. */
    private dbgReady = false;

    constructor(
        /** Readable stream from the editor (process.stdin in normal use). */
        private readonly editorIn:  NodeJS.ReadableStream,
        /** Writable stream to the editor (process.stdout in normal use). */
        private readonly editorOut: NodeJS.WritableStream,
    ) {}

    /** Start the adapter: begin reading from editor. */
    start(): void {
        const editorReader = new DapReader(this.editorIn as import('node:stream').Readable);
        editorReader.on('message', (msg: DapMessage) => this.onEditorMessage(msg));
        editorReader.on('end', () => this.shutdown());
        this.editorIn.resume();
    }

    // ── Editor → Adapter ─────────────────────────────────────────────────────

    private async onEditorMessage(msg: DapMessage): Promise<void> {
        if (msg.type === 'request') {
            const req = msg as DapRequest;
            if (req.command === 'launch') {
                await this.handleLaunch(req);
                return;
            }
        }
        // Forward everything else directly to the native debugger
        this.forwardToDebugger(msg);
    }

    // ── Launch interception ───────────────────────────────────────────────────

    private async handleLaunch(req: DapRequest): Promise<void> {
        const args = req.arguments as {
            program?:     string;
            sourceFile?:  string;
            args?:        string[];
            env?:         Record<string, string>;
            stopOnEntry?: boolean;
            [k: string]:  unknown;
        };

        // Resolve the .code source file from the launch config.
        const sourceFile = args.sourceFile ?? args.program ?? '';

        if (!sourceFile.endsWith('.code')) {
            // Not a .code file — pass through as-is (user might be debugging a binary directly)
            this.startNativeDebugger();
            this.forwardToDebugger(req);
            return;
        }

        // 1. Send a fake "output" event so the editor shows compilation progress
        this.sendToEditor({
            seq:   this.seq++,
            type:  'event',
            event: 'output',
            body:  {
                category: 'console',
                output:   `CodeLang: compiling ${sourceFile} with debug info…\n`,
            },
        });

        // 2. Compile
        let binaryPath: string;
        try {
            const result = await compileForDebug(sourceFile, args.env);
            binaryPath = result.binaryPath;
            this.tmpDirs.push(result.tmpDir);
        } catch (err) {
            // Send a proper error response so the editor shows the message
            this.sendToEditor({
                seq:         this.seq++,
                type:        'response',
                request_seq: req.seq,
                success:     false,
                command:     req.command,
                message:     String(err instanceof Error ? err.message : err),
            });
            // Also send a terminated event so the debugger session ends cleanly
            this.sendToEditor({ seq: this.seq++, type: 'event', event: 'terminated', body: {} });
            return;
        }

        this.sendToEditor({
            seq:   this.seq++,
            type:  'event',
            event: 'output',
            body:  {
                category: 'console',
                output:   `CodeLang: compiled → ${binaryPath}\n`,
            },
        });

        // 3. Start the native debugger
        this.startNativeDebugger();

        // 4. Rewrite the launch request: point program at the binary, not the .code file
        const patchedReq: DapMessage = {
            ...req,
            arguments: {
                ...args,
                // For lldb-dap / gdb: use `program` for the binary
                program:    binaryPath,
                // Keep sourceFile so the editor can still display .code sources
                // (lldb will pick up sources via DWARF if they're in the same dir)
                sourceFile: undefined,
            },
        };
        delete (patchedReq.arguments as Record<string, unknown>).sourceFile;

        this.forwardToDebugger(patchedReq);
    }

    // ── Native debugger process ───────────────────────────────────────────────

    private startNativeDebugger(): void {
        if (this.dbgProc) return; // already started

        let dbgInfo: ReturnType<typeof findDebugger>;
        try {
            dbgInfo = findDebugger();
        } catch (err) {
            this.sendToEditor({
                seq:   this.seq++,
                type:  'event',
                event: 'output',
                body:  { category: 'console', output: `CodeLang debugger error: ${err}\n` },
            });
            return;
        }

        const proc = spawn(
            dbgInfo.executable,
            dbgInfo.extraArgs ?? [],
            { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        this.dbgProc = proc;

        proc.on('exit', () => this.shutdown());
        proc.stderr.on('data', (d: Buffer) => process.stderr.write(d));

        // Read DAP messages from the native debugger and forward to editor
        this.dbgReader = new DapReader(proc.stdout);
        this.dbgReader.on('message', (msg: DapMessage) => {
            this.sendToEditor(msg);
        });

        this.dbgReady = true;

        // Flush any queued messages
        for (const m of this.pendingToDbg) {
            sendDap(proc.stdin, m);
        }
        this.pendingToDbg = [];
    }

    // ── Routing helpers ───────────────────────────────────────────────────────

    private forwardToDebugger(msg: DapMessage): void {
        if (this.dbgReady && this.dbgProc) {
            sendDap(this.dbgProc.stdin, msg);
        } else {
            this.pendingToDbg.push(msg);
        }
    }

    private sendToEditor(msg: DapMessage): void {
        sendDap(this.editorOut as import('node:stream').Writable, msg);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    private shutdown(): void {
        if (this.dbgProc && !this.dbgProc.killed) {
            this.dbgProc.kill();
        }
        for (const d of this.tmpDirs) {
            try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        this.tmpDirs = [];
    }
}
