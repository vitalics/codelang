/**
 * CodeLang Language Server — entry point.
 *
 * Spawned as a child process by the VS Code extension client.
 * Communicates over stdio/IPC using the Language Server Protocol.
 *
 * To run standalone (e.g. for Neovim / Helix / Zed):
 *   node out/language-server/main.js --stdio
 */
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node.js';
import { createCodeLangLSPServices } from '../language/codelang-lsp-module.js';

// Create the IPC / stdio connection to the LSP client.
const connection = createConnection(ProposedFeatures.all);

// Build the full service graph (core + LSP providers).
const { shared } = createCodeLangLSPServices({
    connection,
    ...NodeFileSystem,
});

// Hand control to Langium's generic LSP dispatcher —
// registers all handlers (completion, definition, references, …) on the connection.
startLanguageServer(shared);
