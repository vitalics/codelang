/**
 * Data model for the CodeLang documentation generator.
 *
 * A single source file produces one `ModuleDoc` which contains one
 * `FunctionDoc` per function declaration.  Each `FunctionDoc` may carry an
 * attached `DocComment` parsed from the `/** … *\/` block immediately above
 * the function.
 */

// ── Doc-comment model ─────────────────────────────────────────────────────────

export interface DocParam {
    /** Parameter name (matches the function signature). */
    name: string;
    /** Human-readable description from `@param name description`. */
    description: string;
}

export interface DocComment {
    /** Free-form description text (before any @tags). */
    description: string;
    /** Documented parameters (`@param`). */
    params: DocParam[];
    /** Return-value description (`@returns`). */
    returns?: string;
    /** Example code blocks (`@example`). */
    examples: string[];
    /** 0-indexed last line of the `/** … *\/` block in the source file. */
    endLine: number;
}

// ── Function model ────────────────────────────────────────────────────────────

export interface ParamInfo {
    name: string;
    typeName: string;    // resolved type name (e.g. "Int32", "String", "void")
    immutable: boolean;  // declared with `const` keyword
}

export interface FunctionDoc {
    name: string;
    isExport:   boolean;
    isComptime: boolean;
    params:     ParamInfo[];
    returnType: string | null;  // null = no return-type annotation
    doc:        DocComment | null;
    startLine:  number;         // 0-indexed start line in source file
}

// ── Import model ─────────────────────────────────────────────────────────────

export type ImportKind = 'bare' | 'namespace';

export interface ImportDoc {
    kind:   ImportKind;
    source: string;   // module path string (e.g. "./greetings")
    /** Alias name — only set when kind = 'namespace' (e.g. `const g = import "..."` → name = "g"). */
    alias?: string;
    /** Relative URL to the generated doc page for this import (e.g. "greetings.html").
     *  Set by the doc command when the module is part of the resolved dependency graph. */
    docHref?: string;
}

// ── Module model ──────────────────────────────────────────────────────────────

export interface ModuleDoc {
    /** Absolute path of the source file. */
    sourceFile: string;
    imports:    ImportDoc[];
    functions:  FunctionDoc[];
}
