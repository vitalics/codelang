/**
 * CodeLang VS Code Extension — client activation.
 *
 * Responsibilities:
 *  1. Start the CodeLang LSP client (language server child process).
 *  2. Register the CodeLang debug adapter descriptor factory so VS Code
 *     knows how to launch `codelang-dap` (the DAP proxy).
 *  3. Register a DebugConfigurationProvider that auto-fills launch.json
 *     when no debug configuration exists.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type {
    ExtensionContext,
    DebugConfiguration,
    WorkspaceFolder,
    CancellationToken,
    ProviderResult,
    DebugAdapterDescriptorFactory,
    DebugAdapterExecutable,
    DebugSession,
    DebugAdapterDescriptor,
} from 'vscode';
import {
    LanguageClient,
    type LanguageClientOptions,
    type ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client: LanguageClient | undefined;

// ── Debug adapter descriptor factory ─────────────────────────────────────────

class CodeLangDebugAdapterFactory implements DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        _session: DebugSession,
        _executable: DebugAdapterExecutable | undefined,
    ): ProviderResult<DebugAdapterDescriptor> {
        // The DAP adapter lives in debugger/out/index.js relative to the extension root.
        // __dirname here is out/ — go up one level to the extension root.
        const extensionRoot = path.resolve(__dirname, '..');
        const adapterScript  = path.join(extensionRoot, 'debugger', 'out', 'index.js');
        return new vscode.DebugAdapterExecutable('node', [adapterScript]);
    }
}

// ── Debug configuration provider ─────────────────────────────────────────────

class CodeLangDebugConfigProvider implements vscode.DebugConfigurationProvider {
    /**
     * Called when VS Code is about to start a debug session.
     * Fills in defaults that were omitted from launch.json.
     */
    resolveDebugConfiguration(
        _folder: WorkspaceFolder | undefined,
        config: DebugConfiguration,
        _token?: CancellationToken,
    ): ProviderResult<DebugConfiguration> {
        // No launch.json at all — auto-fill from the active editor
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'codelang') {
                config.type        = 'codelang';
                config.name        = 'Debug CodeLang Program';
                config.request     = 'launch';
                config.sourceFile  = editor.document.fileName;
                config.stopOnEntry = false;
            }
        }

        // Ensure sourceFile is absolute
        if (config.sourceFile && !path.isAbsolute(config.sourceFile)) {
            const root = _folder?.uri.fsPath ?? process.cwd();
            config.sourceFile = path.join(root, config.sourceFile);
        }

        return config;
    }

    /** Provide dynamic initial configurations for the "Add Configuration" picker. */
    provideDebugConfigurations(
        _folder: WorkspaceFolder | undefined,
    ): ProviderResult<DebugConfiguration[]> {
        return [
            {
                type:        'codelang',
                request:     'launch',
                name:        'Debug CodeLang Program',
                sourceFile:  '${file}',
                stopOnEntry: false,
            },
            {
                type:        'codelang',
                request:     'launch',
                name:        'Debug CodeLang Program (stop on entry)',
                sourceFile:  '${file}',
                stopOnEntry: true,
            },
        ];
    }
}

// ── Extension activation ──────────────────────────────────────────────────────

export function activate(context: ExtensionContext): void {
    // ── 1. Language server (LSP) ──────────────────────────────────────────────
    const serverModule = path.join(__dirname, 'language-server', 'main.js');

    const serverOptions: ServerOptions = {
        run: {
            module:    serverModule,
            transport: TransportKind.ipc,
        },
        debug: {
            module:    serverModule,
            transport: TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6009'] },
        },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'codelang' }],
    };

    client = new LanguageClient('codelang', 'CodeLang', serverOptions, clientOptions);
    client.start();
    context.subscriptions.push({ dispose: () => client!.stop() });

    // ── 2. Debug adapter ──────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(
            'codelang',
            new CodeLangDebugAdapterFactory(),
        ),
    );

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            'codelang',
            new CodeLangDebugConfigProvider(),
            vscode.DebugConfigurationProviderTriggerKind.Dynamic,
        ),
    );

    // Also register for the initial (static) configurations trigger
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            'codelang',
            new CodeLangDebugConfigProvider(),
        ),
    );
}

export async function deactivate(): Promise<void> {
    await client?.stop();
}
