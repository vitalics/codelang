import type { AstNode, LangiumDocument, LangiumCoreServices } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import { URI } from 'langium';
import chalk from 'chalk';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as url from 'node:url';
import { formatDiagnostics } from './error-format.js';
import type { Program } from '../language/generated/ast.js';
import {
    isFunctionDeclaration,
    isTypeDeclaration,
    isExtensionDeclaration,
    isExternDeclaration,
    isProtocolDeclaration,
    isEnumDeclaration,
    isSwitchArm,
    isMacroCallExpression,
    isMacroCallStatement,
    isTopLevelMacroCall,
    isVariableRef,
} from '../language/generated/ast.js';
import type { SwitchArm, MacroCallExpression, MacroCallStatement, TopLevelMacroCall } from '../language/generated/ast.js';

// ── Stdlib location ───────────────────────────────────────────────────────────
// Resolved relative to this file so it works regardless of CWD.

const __dirname  = url.fileURLToPath(new URL('.', import.meta.url));
// When compiled:  out/cli/cli-util.js  →  ../../stdlib
const STDLIB_DIR = path.resolve(__dirname, '..', '..', 'stdlib');

// ── Load stdlib into the Langium workspace ────────────────────────────────────

/**
 * Pre-loads all stdlib `.code` files so that cross-references to types like
 * `Int32`, `String`, `Boolean` etc. can be resolved when compiling user code.
 *
 * Stdlib files are built without validation (they are trusted source).
 */
/** Recursively collect all *.code files under a directory (depth-first). */
function collectCodeFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectCodeFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.code')) {
            results.push(full);
        }
    }
    return results;
}

async function loadStdlib(services: LangiumCoreServices): Promise<void> {
    if (!fs.existsSync(STDLIB_DIR)) return;

    const files = collectCodeFiles(STDLIB_DIR);

    if (files.length === 0) return;

    const docs: LangiumDocument[] = [];
    for (const file of files) {
        const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
            URI.file(file)
        );
        docs.push(doc);
    }

    // Build without validation — stdlib is trusted, and we don't want its
    // diagnostics mixed in with user-file diagnostics.
    await services.shared.workspace.DocumentBuilder.build(docs, { validation: false });
}

// ── Document extraction ───────────────────────────────────────────────────────

export async function extractDocument(
    fileName: string,
    services: LangiumCoreServices
): Promise<LangiumDocument> {
    const extensions = services.LanguageMetaData.fileExtensions;
    if (!extensions.includes(path.extname(fileName))) {
        console.error(
            chalk.yellow(
                `Please choose a file with one of these extensions: ${extensions.join(', ')}`
            )
        );
        process.exit(1);
    }

    if (!fs.existsSync(fileName)) {
        console.error(chalk.red(`File not found: ${fileName}`));
        process.exit(1);
    }

    // 1. Load stdlib so type cross-references can be resolved.
    await loadStdlib(services);

    // 2. Load the user document.
    const document = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
        URI.file(path.resolve(fileName))
    );

    // 3. Build (parse + link + validate) the user document.
    //    Linking now has access to all stdlib TypeDeclarations.
    await services.shared.workspace.DocumentBuilder.build([document], { validation: true });

    // Collect all type parameter names from the program so we can suppress
    // "Could not resolve reference to TypeDeclaration named 'T'" linker errors
    // that arise because TypeParam names look like type cross-references.
    const typeParamNames = collectTypeParamNames(document.parseResult?.value as Program | undefined);

    // Collect enum pattern binding names so we can suppress
    // "Could not resolve reference to NamedVar named 'r'" linker errors.
    // These bindings are introduced by EnumPattern arms (e.g. Shape::Circle(r)),
    // but Langium's default scoping doesn't propagate them to the arm body.
    const enumBindingNames = collectEnumBindingNames(document.parseResult?.value as Program | undefined);

    const errors = (document.diagnostics ?? [])
        .filter((e: Diagnostic) => e.severity === 1)
        .filter((e: Diagnostic) => {
            // Suppress unresolved-reference errors for type parameter names.
            // Langium may emit either "TypeDeclaration" or "NamedType" depending on
            // whether the cross-reference target is the base rule or the union alias.
            const typeMatch = e.message.match(/^Could not resolve reference to (?:TypeDeclaration|NamedType) named '(\w+)'\./);
            if (typeMatch && typeParamNames.has(typeMatch[1])) return false;
            // Suppress unresolved-reference errors for enum pattern binding names.
            const varMatch = e.message.match(/^Could not resolve reference to NamedVar named '(\w+)'\./);
            if (varMatch && enumBindingNames.has(varMatch[1])) return false;
            return true;
        });
    if (errors.length > 0) {
        const sourceText = document.textDocument.getText();
        console.error(formatDiagnostics(errors, fileName, sourceText));
        process.exit(1);
    }

    return document;
}

export async function extractAstNode<T extends AstNode>(
    fileName: string,
    services: LangiumCoreServices
): Promise<T> {
    return (await extractDocument(fileName, services)).parseResult?.value as T;
}

/**
 * Walk the program AST and collect all TypeParam names from declarations that
 * support generic parameters (TypeDeclaration, FunctionDeclaration,
 * ExternDeclaration, ExtensionDeclaration).
 *
 * These names need to be excluded from "Could not resolve reference" errors
 * because TypeParam names appear as TypeReference cross-refs whose targets
 * do not exist as TypeDeclaration nodes.
 */
/**
 * Collect names that should suppress `NamedVar` unresolved-reference errors.
 *
 * Covers two cases:
 *
 * 1. Enum pattern binding names — introduced by EnumPattern arms like
 *    `Shape::Circle(r) => …`.  Langium's default scoping doesn't propagate
 *    these bindings into the arm body, so we suppress the false errors.
 *
 * 2. Bare identifiers used as macro call arguments where the identifier is a
 *    type name (e.g. `size_of!(int)`).  The grammar parses these as VariableRef
 *    nodes that look up NamedVar, but in macro context they refer to types.
 *    We suppress the resulting reference errors rather than carving out a
 *    separate grammar rule for "macro type-argument position".
 */
function collectEnumBindingNames(program: Program | undefined): Set<string> {
    const names = new Set<string>();
    if (!program) return names;
    // Walk all AST nodes using BFS (avoids stack overflow; skips Langium internals)
    const queue: AstNode[] = [program as AstNode];
    const visited = new Set<AstNode>();
    while (queue.length > 0) {
        const node = queue.shift()!;
        if (visited.has(node)) continue;
        visited.add(node);

        // ── Enum pattern bindings ──────────────────────────────────────────────
        if (isSwitchArm(node as AstNode)) {
            const arm = node as SwitchArm;
            if (arm.enumPat) {
                for (const b of arm.enumPat.bindings) {
                    if (!b.wildcard && b.name) names.add(b.name);
                }
            }
        }

        // ── Macro call arguments used as bare type identifiers ─────────────────
        // Collect VariableRef names that appear as direct arguments to macro calls
        // (e.g. `size_of!(int)` → suppress the NamedVar error for `int`).
        const collectMacroArgs = (args: readonly AstNode[]) => {
            for (const arg of args) {
                if (isVariableRef(arg) && arg.ref?.$refText) {
                    names.add(arg.ref.$refText);
                }
            }
        };
        if (isMacroCallExpression(node as AstNode)) {
            collectMacroArgs((node as MacroCallExpression).args);
        }
        if (isMacroCallStatement(node as AstNode)) {
            collectMacroArgs((node as MacroCallStatement).args);
        }
        if (isTopLevelMacroCall(node as AstNode)) {
            collectMacroArgs((node as TopLevelMacroCall).args);
        }

        // Enqueue child AST nodes (skip Langium metadata properties)
        for (const key of Object.keys(node)) {
            if (key.startsWith('$')) continue; // skip $container, $type, $cstNode, etc.
            const val = (node as unknown as Record<string, unknown>)[key];
            if (val && typeof val === 'object') {
                if (Array.isArray(val)) {
                    for (const item of val) {
                        if (item && typeof item === 'object' && '$type' in item && !visited.has(item as AstNode)) {
                            queue.push(item as AstNode);
                        }
                    }
                } else if ('$type' in val && !visited.has(val as AstNode)) {
                    queue.push(val as AstNode);
                }
            }
        }
    }
    return names;
}

function collectTypeParamNames(program: Program | undefined): Set<string> {
    const names = new Set<string>();
    if (!program) return names;
    for (const elem of program.elements) {
        if (isTypeDeclaration(elem)) {
            for (const tp of (elem as any).typeParams ?? []) names.add(tp.name);
        }
        if (isFunctionDeclaration(elem)) {
            for (const tp of (elem as any).typeParams ?? []) names.add(tp.name);
        }
        if (isExternDeclaration(elem)) {
            for (const tp of (elem as any).typeParams ?? []) names.add(tp.name);
        }
        if (isExtensionDeclaration(elem)) {
            for (const tp of (elem as any).typeParams ?? []) names.add(tp.name);
        }
        if (isProtocolDeclaration(elem)) {
            for (const tp of (elem as any).typeParams ?? []) names.add(tp.name);
        }
        // Collect type parameter names from enum declarations (e.g. Option<T>, Result<T,E>)
        if (isEnumDeclaration(elem)) {
            for (const tp of (elem as any).typeParams ?? []) names.add(tp.name);
        }
    }
    return names;
}
