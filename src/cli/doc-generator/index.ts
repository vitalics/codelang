/**
 * Documentation generator entry point.
 *
 * Wires together:
 *   extractor  — raw-text doc-comment scanner + AST-to-ModuleDoc builder
 *   renderer   — ModuleDoc → self-contained HTML page
 */

export { buildModuleDoc } from './extractor.js';
export { renderHtml     } from './renderer.js';
export type { RenderContext } from './renderer.js';
export type { ModuleDoc, FunctionDoc, DocComment } from './types.js';
