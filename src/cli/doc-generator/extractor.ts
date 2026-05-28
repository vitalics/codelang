/**
 * Extracts JSDoc-style doc comments from CodeLang source text and pairs them
 * with the `FunctionDeclaration` AST nodes that immediately follow them.
 *
 * Doc comments use the  /** … *\/  syntax (a superset of the existing
 * hidden ML_COMMENT terminal).  Because Langium strips comments from the CST
 * we scan the raw source text instead, matching each comment to the function
 * on the line directly after (or at most two lines below, to allow a blank
 * separator line between comment and declaration).
 *
 * Supported tags
 * ──────────────
 *   @param  <name>  <description>
 *   @returns        <description>        (also: @return)
 *   @example
 *   <code block>
 */

import type { Program, TypeReference } from '../../language/generated/ast.js';
import { isFunctionDeclaration, isBareImport, isNamespaceImport } from '../../language/generated/ast.js';
import type { DocComment, FunctionDoc, ImportDoc, ModuleDoc, ParamInfo } from './types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function typeRefName(tr: TypeReference | undefined): string | null {
    if (!tr) return null;
    if (tr.primitive) return tr.primitive;              // 'void'
    return tr.ref?.$refText ?? null;                    // 'Int32', 'String', …
}

// ── Text scanner ──────────────────────────────────────────────────────────────

/**
 * Walk the source text and return every `/** … *\/` doc block with the
 * 0-indexed line number of its closing `*\/`.
 */
function extractDocComments(source: string): DocComment[] {
    const results: DocComment[] = [];
    const lines = source.split('\n');
    let i = 0;

    while (i < lines.length) {
        const trimmed = lines[i].trimStart();

        if (!trimmed.startsWith('/**')) { i++; continue; }

        // ── Single-line: /** description */ ──────────────────────────────────
        const singleLineRx = /^\/\*\*(.*?)\*\/\s*$/;
        const single = trimmed.match(singleLineRx);
        if (single) {
            const parsed = parseDocComment([single[1].trim()]);
            parsed.endLine = i;
            results.push(parsed);
            i++;
            continue;
        }

        // ── Multi-line ────────────────────────────────────────────────────────
        const commentLines: string[] = [];

        // Text after `/**` on the opening line (if any)
        const openRest = trimmed.replace(/^\/\*\*\s?/, '').replace(/\*\/\s*$/, '').trim();
        if (openRest) commentLines.push(openRest);
        i++;

        while (i < lines.length) {
            const line = lines[i].trimStart();
            if (line.startsWith('*/')) break;
            // Strip the conventional leading ` * ` (or ` *`)
            commentLines.push(line.replace(/^\*\s?/, ''));
            i++;
        }

        const parsed = parseDocComment(commentLines);
        parsed.endLine = i; // line that holds `*/`
        results.push(parsed);
        i++;
    }

    return results;
}

// ── Tag parser ────────────────────────────────────────────────────────────────

function parseDocComment(lines: string[]): DocComment {
    const descLines: string[] = [];
    const params: DocComment['params'] = [];
    let returns: string | undefined;
    const exampleLines: string[] = [];
    const examples: string[] = [];
    let inExample = false;

    for (const raw of lines) {
        const line = raw.trim();

        const paramMatch  = line.match(/^@param\s+(\S+)\s*(.*)/);
        const returnMatch = line.match(/^@returns?\s+(.*)/);
        const exampleMatch= line.match(/^@example\s*(.*)/);

        if (paramMatch) {
            if (inExample && exampleLines.length) {
                examples.push(exampleLines.splice(0).join('\n').trim());
            }
            inExample = false;
            params.push({
                name:        paramMatch[1].replace(/^-\s*/, ''),
                description: paramMatch[2].replace(/^-\s*/, ''),
            });
        } else if (returnMatch) {
            if (inExample && exampleLines.length) {
                examples.push(exampleLines.splice(0).join('\n').trim());
            }
            inExample = false;
            returns = returnMatch[1];
        } else if (exampleMatch) {
            if (inExample && exampleLines.length) {
                examples.push(exampleLines.splice(0).join('\n').trim());
            }
            inExample = true;
            if (exampleMatch[1]) exampleLines.push(exampleMatch[1]);
        } else if (inExample) {
            exampleLines.push(raw); // keep original indentation
        } else {
            descLines.push(line);
        }
    }

    if (inExample && exampleLines.length) {
        examples.push(exampleLines.join('\n').trim());
    }

    return {
        description: descLines.join('\n').replace(/^\n+|\n+$/g, '').trim(),
        params,
        returns,
        examples,
        endLine: 0, // set by the caller
    };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a `ModuleDoc` by combining the parsed Langium AST with doc comments
 * extracted from the raw source text.
 *
 * @param importHrefs  Optional map from import source string (e.g. `"./utils"`)
 *                     to the HTML filename for that module (e.g. `"utils.html"`).
 *                     When provided, each `ImportDoc.docHref` is populated so the
 *                     renderer can emit clickable cross-links.
 */
export function buildModuleDoc(
    program:    Program,
    source:     string,
    sourceFile: string,
    importHrefs?: Map<string, string>,
): ModuleDoc {
    const docComments = extractDocComments(source);
    const imports:   ImportDoc[]   = [];
    const functions: FunctionDoc[] = [];

    for (const elem of program.elements) {
        // ── Imports ───────────────────────────────────────────────────────────
        if (isBareImport(elem)) {
            imports.push({
                kind: 'bare',
                source: elem.source,
                docHref: importHrefs?.get(elem.source),
            });
            continue;
        }
        if (isNamespaceImport(elem)) {
            imports.push({
                kind: 'namespace',
                source: elem.source,
                alias: elem.name,
                docHref: importHrefs?.get(elem.source),
            });
            continue;
        }

        // ── Functions ─────────────────────────────────────────────────────────
        if (!isFunctionDeclaration(elem)) continue;

        const startLine = elem.$cstNode?.range.start.line ?? 0;

        // A doc comment is "attached" if it ends on the line immediately before
        // the function (or with one blank line gap).
        const doc = docComments.find(dc =>
            dc.endLine === startLine - 1 ||
            dc.endLine === startLine - 2
        ) ?? null;

        const params: ParamInfo[] = elem.parameters.map(p => ({
            name:      p.name,
            typeName:  typeRefName(p.type) ?? '?',
            immutable: p.immutable,
        }));

        functions.push({
            name:       elem.name,
            isExport:   elem.export,
            isComptime: elem.comptime,
            params,
            returnType: typeRefName(elem.returnType) ?? null,
            doc,
            startLine,
        });
    }

    return { sourceFile, imports, functions };
}
