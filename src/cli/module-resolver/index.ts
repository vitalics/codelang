/**
 * Module resolver for CodeLang.
 *
 * Responsibilities:
 *   1. Resolve a module specifier to an absolute file path
 *      (Rust + Node.js style: ./foo → foo.code → foo/index.code)
 *   2. Transitively load all imported modules
 *   3. Detect import cycles with DFS (gray/black colouring)
 *   4. Return a topologically-ordered list of ResolvedModule objects
 *      (dependencies first, entry-point last)
 *
 * Only relative paths ("./" and "../") are supported in this release.
 * Non-relative imports produce a clear error with a migration hint.
 */

import * as path from 'node:path';
import * as fs   from 'node:fs';
import * as url  from 'node:url';
import type { LangiumCoreServices } from 'langium';
import type { Program, FunctionDeclaration } from '../../language/generated/ast.js';
import {
    isFunctionDeclaration,
    isExternDeclaration,
    isTypeDeclaration,
    isBareImport,
    isNamespaceImport,
    isSwitchImport,
    isExtensionDeclaration,
} from '../../language/generated/ast.js';
import { extractAstNode } from '../cli-util.js';

// ── Public types ──────────────────────────────────────────────────────────────

/** A fully-loaded module with its AST and export metadata. */
export interface ResolvedModule {
    /** Absolute path of the source file. */
    filePath:      string;
    /** Parsed + validated AST root. */
    program:       Program;
    /** Names of functions that carry the `export` modifier. */
    exportedNames: Set<string>;
}

/**
 * The complete dependency graph for one compilation.
 *
 * `modules` is sorted so that every module appears *after* all its transitive
 * dependencies (i.e. safe to emit IR in this order).
 */
export interface ModuleGraph {
    /** Topological order — dependencies before dependents. */
    modules:   ResolvedModule[];
    /** Absolute path of the file the user asked to compile. */
    entryPath: string;
}

// ── Stdlib root locator ───────────────────────────────────────────────────────

/**
 * Find the CodeLang standard library directory.
 *
 * Resolution order:
 *   1. CODELANG_STDLIB environment variable (absolute path)
 *   2. <compiled-script-dir>/../../../stdlib  (out/cli/module-resolver/ → project root)
 *   3. <cwd>/stdlib                           (CWD fallback for development)
 */
function findStdlibRoot(): string {
    if (process.env.CODELANG_STDLIB) return process.env.CODELANG_STDLIB;

    const scriptDir = path.dirname(url.fileURLToPath(import.meta.url));
    const candidate = path.resolve(scriptDir, '..', '..', '..', 'stdlib');
    if (fs.existsSync(candidate)) return candidate;

    const cwdFallback = path.resolve(process.cwd(), 'stdlib');
    if (fs.existsSync(cwdFallback)) return cwdFallback;

    throw new ModuleResolutionError(
        'Cannot locate the stdlib directory.\n' +
        `  Tried: ${candidate}\n` +
        `         ${cwdFallback}\n` +
        '  Hint: set the CODELANG_STDLIB environment variable to the stdlib path.',
    );
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * Resolve an import specifier to an absolute `.code` file path.
 *
 * Resolution order (mirrors Node.js `require` for clarity):
 *   1. `<spec>.code`           if `spec` does not already end with `.code`
 *   2. `<spec>/index.code`     directory-style import
 *   3. `<spec>`                if the caller passed the extension explicitly
 */
export function resolveModulePath(spec: string, fromDir: string): string {
    // ── Stdlib imports: "stdlib/buffer", "stdlib/array", … ───────────────────
    if (spec === 'stdlib' || spec.startsWith('stdlib/')) {
        const stdlibRoot = findStdlibRoot();
        const sub  = spec === 'stdlib' ? 'index' : spec.slice('stdlib/'.length);
        const base = path.resolve(stdlibRoot, sub);

        if (sub.endsWith('.code')) {
            if (fs.existsSync(base)) return base;
            throw new ModuleResolutionError(moduleNotFound(spec, base, null));
        }
        const withExt   = `${base}.code`;
        if (fs.existsSync(withExt)) return withExt;

        const indexFile = path.join(base, 'index.code');
        if (fs.existsSync(indexFile)) return indexFile;

        throw new ModuleResolutionError(moduleNotFound(spec, withExt, indexFile));
    }

    if (!spec.startsWith('./') && !spec.startsWith('../')) {
        throw new ModuleResolutionError(
            `Non-relative imports are not supported: "${spec}"\n` +
            `  Hint: use a relative path ("./utils") or a stdlib import ("stdlib/buffer")`,
        );
    }

    const base = path.resolve(fromDir, spec);

    if (spec.endsWith('.code')) {
        if (fs.existsSync(base)) return base;
        throw new ModuleResolutionError(moduleNotFound(spec, base, null));
    }

    const withExt = `${base}.code`;
    if (fs.existsSync(withExt)) return withExt;

    const indexFile = path.join(base, 'index.code');
    if (fs.existsSync(indexFile)) return indexFile;

    throw new ModuleResolutionError(moduleNotFound(spec, withExt, indexFile));
}

function moduleNotFound(spec: string, tried1: string, tried2: string | null): string {
    const lines = [`Cannot find module "${spec}"\n  Looked for:`];
    lines.push(`    ${tried1}`);
    if (tried2) lines.push(`    ${tried2}`);
    return lines.join('\n');
}

// ── Module graph builder ──────────────────────────────────────────────────────

/**
 * Parse the entry file and all its transitive imports, detect cycles, and
 * return the resolved graph in dependency-first topological order.
 */
export async function resolveModuleGraph(
    entryFile: string,
    services:  LangiumCoreServices,
): Promise<ModuleGraph> {
    const absEntry = path.resolve(entryFile);
    const cache    = new Map<string, ResolvedModule>();
    const depEdges = new Map<string, string[]>(); // path → [imported absolute paths]

    // ── Recursive loader ──────────────────────────────────────────────────────

    async function loadModule(filePath: string): Promise<void> {
        if (cache.has(filePath)) return; // already loaded

        const program = await extractAstNode<Program>(filePath, services);

        // Collect exported names (functions, extern fns, types)
        const exportedNames = new Set<string>();
        for (const elem of program.elements) {
            if (isFunctionDeclaration(elem) && (elem as FunctionDeclaration).export) {
                exportedNames.add((elem as FunctionDeclaration).name);
            }
            if (isExternDeclaration(elem) && elem.export) {
                exportedNames.add(elem.name);
            }
            if (isTypeDeclaration(elem) && elem.export) {
                exportedNames.add(elem.name);
            }
            if (isExtensionDeclaration(elem)) {
                const typeDecl = (elem as any).typeName?.ref;
                if (typeDecl) {
                    for (const method of (elem as any).methods) {
                        if (method.export) {
                            exportedNames.add(`${typeDecl.name}_${method.name}`);
                        }
                    }
                }
            }
        }

        cache.set(filePath, { filePath, program, exportedNames });

        // Resolve + load imports (bare, namespace, and switch_import! forms).
        const deps: string[] = [];
        for (const elem of program.elements) {
            let source: string | undefined;
            if (isBareImport(elem))      source = elem.source;
            if (isNamespaceImport(elem)) source = elem.source;

            if (isSwitchImport(elem)) {
                // Evaluate the compile-time condition and select the matching arm.
                const condValue = evalCompileCondition(elem.condObj, elem.condMethod);
                source = elem.elsePath;                    // default: else branch
                for (const arm of elem.arms) {
                    if (arm.pattern === condValue) { source = arm.path; break; }
                }
            }

            if (!source) continue;

            const depPath = resolveModulePath(source, path.dirname(filePath));
            deps.push(depPath);
            await loadModule(depPath); // depth-first
        }

        depEdges.set(filePath, deps);
    }

    await loadModule(absEntry);

    // ── Cycle detection (DFS with gray/black colouring) ──────────────────────

    const gray  = new Set<string>(); // currently on the call stack
    const black = new Set<string>(); // fully explored

    function detectCycle(node: string, stack: string[]): void {
        if (black.has(node)) return;
        if (gray.has(node)) {
            const cycleStart = stack.indexOf(node);
            const cycle = [...stack.slice(cycleStart), node];
            throw new CyclicDependencyError(cycle);
        }

        gray.add(node);
        stack.push(node);

        for (const dep of depEdges.get(node) ?? []) {
            detectCycle(dep, stack);
        }

        stack.pop();
        gray.delete(node);
        black.add(node);
    }

    detectCycle(absEntry, []);

    // ── Topological sort (post-order DFS) ────────────────────────────────────

    const visited = new Set<string>();
    const order:   string[] = [];

    function topoVisit(node: string): void {
        if (visited.has(node)) return;
        visited.add(node);
        for (const dep of depEdges.get(node) ?? []) topoVisit(dep);
        order.push(node);
    }

    topoVisit(absEntry);

    const modules = order.map(p => cache.get(p)!);
    return { modules, entryPath: absEntry };
}

// ── Build function table ──────────────────────────────────────────────────────

/**
 * Collect every FunctionDeclaration from all modules into a single look-up
 * map (name → declaration).  Used by the IR generator and validator to
 * resolve call targets.
 */
export function buildFunctionTable(
    modules: ResolvedModule[],
): Map<string, FunctionDeclaration> {
    const table = new Map<string, FunctionDeclaration>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (isFunctionDeclaration(elem)) {
                table.set((elem as FunctionDeclaration).name, elem as FunctionDeclaration);
            }
        }
    }
    return table;
}

// ── Compile-time condition evaluator ─────────────────────────────────────────

/**
 * Evaluate a `switch_import!` condition of the form `<obj>.<method>()`.
 *
 * The only supported namespace is `compile`, which exposes host-machine
 * properties of the compiler process:
 *
 *   compile.arch()     — Node.js process.arch   e.g. "arm64", "x64"
 *   compile.os()       — Node.js process.platform  e.g. "darwin", "linux"
 *   compile.platform() — combined "<os>-<arch>"  e.g. "darwin-arm64"
 *
 * Unknown namespaces or methods return an empty string so that the `else`
 * branch is always chosen as a safe fallback.
 */
export function evalCompileCondition(obj: string, method: string): string {
    if (obj !== 'compile') return '';
    switch (method) {
        case 'arch':     return process.arch;
        case 'os':       return process.platform;
        case 'platform': return `${process.platform}-${process.arch}`;
        default:         return '';
    }
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ModuleResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModuleResolutionError';
    }
}

export class CyclicDependencyError extends Error {
    /** The import cycle as a list of absolute file paths (first === last). */
    readonly cycle: string[];

    constructor(cycle: string[]) {
        const rel = (p: string) => path.relative(process.cwd(), p);
        const arrow = cycle.map(rel).join(' →\n        ');
        super(`Circular import detected:\n        ${arrow}`);
        this.name  = 'CyclicDependencyError';
        this.cycle = cycle;
    }
}

/** True if `importedName` is actually exported by `mod`. */
export function isExportedBy(importedName: string, mod: ResolvedModule): boolean {
    return mod.exportedNames.has(importedName);
}
