/**
 * HTML renderer for CodeLang documentation.
 *
 * Produces a single self-contained `.html` file (no external dependencies)
 * with a docs.rs-inspired layout:
 *
 *   ┌─ sticky header ──────────────────────────────────────┐
 *   │  CodeLang Docs  ·  <filename>                        │
 *   └──────────────────────────────────────────────────────┘
 *   ┌─ sidebar ──────┐  ┌─ main ─────────────────────────┐
 *   │  Functions      │  │  fn entry                      │
 *   │  ├ fn foo       │  │  ├ signature                   │
 *   │  ├ const fn bar │  │  ├ description                 │
 *   │  └ …            │  │  ├ parameters table            │
 *   └─────────────────┘  │  ├ returns                     │
 *                        │  └ example                      │
 *                        └────────────────────────────────┘
 */

import type { ModuleDoc, FunctionDoc, ImportDoc, DocParam } from './types.js';
import * as path from 'node:path';

// ── Render context ────────────────────────────────────────────────────────────

/** Extra context supplied by the multi-module doc command. */
export interface RenderContext {
    /** Every module in the graph with its relative HTML path. */
    allModules?: Array<{ name: string; href: string; isCurrent: boolean }>;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s: string): string {
    return s
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;');
}

// ── Signature renderer ────────────────────────────────────────────────────────

function renderSignature(fn: FunctionDoc): string {
    const kw  = (s: string) => `<span class="sk">${esc(s)}</span>`;
    const nm  = (s: string) => `<span class="sn">${esc(s)}</span>`;
    const ty  = (s: string) => `<span class="st">${esc(s)}</span>`;
    const prm = (s: string) => `<span class="sp">${esc(s)}</span>`;
    const pu  = (s: string) => `<span class="ss">${esc(s)}</span>`;

    const parts: string[] = [];

    if (fn.isExport)   parts.push(kw('export') + ' ');
    if (fn.isComptime) parts.push(kw('const')  + ' ');
    parts.push(kw('fn') + ' ');
    parts.push(nm(fn.name));
    parts.push(pu('('));

    if (fn.params.length > 0) {
        const sep = fn.params.length > 2
            ? pu(',') + '\n    '
            : pu(', ');

        const strs = fn.params.map(p => {
            let s = '';
            if (p.immutable) s += kw('const') + ' ';
            s += prm(p.name) + pu(': ') + ty(p.typeName);
            return s;
        });

        if (fn.params.length > 2) {
            parts.push('\n    ' + strs.join(sep) + '\n');
        } else {
            parts.push(strs.join(sep));
        }
    }

    parts.push(pu(')'));

    if (fn.returnType && fn.returnType !== 'void') {
        parts.push(pu(': ') + ty(fn.returnType));
    }

    return parts.join('');
}

// ── Description renderer ──────────────────────────────────────────────────────

function renderDescription(text: string): string {
    if (!text) return '';
    // Split on blank lines → paragraphs
    return text
        .split(/\n{2,}/)
        .map(p => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

// ── Params table ──────────────────────────────────────────────────────────────

function renderParamsTable(params: DocParam[], fnParams: FunctionDoc['params']): string {
    if (params.length === 0) return '';

    const rows = params.map(dp => {
        const pi = fnParams.find(p => p.name === dp.name);
        const constBadge = pi?.immutable
            ? `<span class="const-badge">const</span> `
            : '';
        return `
        <tr>
          <td class="pt-name"><code>${esc(dp.name)}</code></td>
          <td class="pt-type">${constBadge}<code>${esc(pi?.typeName ?? '')}</code></td>
          <td class="pt-desc">${esc(dp.description)}</td>
        </tr>`;
    }).join('');

    return `
      <div class="section">
        <div class="section-title">Parameters</div>
        <table class="params-table">
          <tbody>${rows}
          </tbody>
        </table>
      </div>`;
}

// ── Function entry ────────────────────────────────────────────────────────────

function renderFunctionEntry(fn: FunctionDoc): string {
    const kindClass = fn.isComptime ? 'comptime' : 'runtime';
    const kindLabel = fn.isComptime ? 'const fn' : 'fn';
    const { doc } = fn;

    let body = `
      <div class="sig-block">${renderSignature(fn)}</div>`;

    if (doc) {
        if (doc.description) {
            body += `
      <div class="description">${renderDescription(doc.description)}</div>`;
        }

        if (doc.params.length > 0) {
            body += renderParamsTable(doc.params, fn.params);
        } else if (fn.params.length > 0) {
            // Function has params but none are documented — show type-only table
            const rows = fn.params.map(p => `
        <tr>
          <td class="pt-name"><code>${esc(p.name)}</code></td>
          <td class="pt-type">${p.immutable ? `<span class="const-badge">const</span> ` : ''}<code>${esc(p.typeName)}</code></td>
          <td class="pt-desc pt-nodoc">—</td>
        </tr>`).join('');
            body += `
      <div class="section">
        <div class="section-title">Parameters</div>
        <table class="params-table"><tbody>${rows}
        </tbody></table>
      </div>`;
        }

        if (doc.returns) {
            body += `
      <div class="section returns-section">
        <div class="section-title">Returns</div>
        <p>${fn.returnType ? `<code class="ret-type">${esc(fn.returnType)}</code> — ` : ''}${esc(doc.returns)}</p>
      </div>`;
        }

        for (const ex of doc.examples) {
            body += `
      <div class="section">
        <div class="section-title">Example</div>
        <pre class="example-block">${esc(ex)}</pre>
      </div>`;
        }
    } else {
        body += `<p class="no-doc">No documentation provided.</p>`;
    }

    const exportBadge = fn.isExport
        ? `<span class="export-badge">pub</span> `
        : '';

    return `
    <article class="fn-entry" id="fn.${esc(fn.name)}">
      <div class="fn-header">
        ${exportBadge}<span class="fn-kind ${kindClass}">${kindLabel}</span>
        <a class="fn-name" href="#fn.${esc(fn.name)}">${esc(fn.name)}</a>
      </div>
      <div class="fn-body">${body}
      </div>
    </article>`;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:           #1b1b1b;
    --surface:      #242427;
    --surface2:     #2c2c30;
    --border:       #3a3a3f;
    --text:         #cdd3de;
    --text-muted:   #7a7f8a;
    --accent:       #4a9eda;
    --fn-color:     #82aaff;
    --kw-color:     #c792ea;
    --ty-color:     #ffcb6b;
    --prm-color:    #c3e88d;
    --sidebar-w:    260px;
    --header-h:     48px;
    font-size: 15px;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.65;
  }

  /* ── Header ── */
  header {
    position: sticky; top: 0; z-index: 200;
    height: var(--header-h);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px;
    padding: 0 24px;
  }
  .logo {
    font-weight: 700; font-size: 1rem;
    color: var(--accent);
    font-family: 'Courier New', monospace;
    letter-spacing: -0.02em;
  }
  .logo-sep { color: var(--border); margin: 0 4px; }
  .source-filename {
    font-family: 'Courier New', monospace;
    font-size: 0.88rem; color: var(--text-muted);
  }

  /* ── Layout ── */
  .layout {
    display: flex;
    min-height: calc(100vh - var(--header-h));
  }

  /* ── Sidebar ── */
  .sidebar {
    width: var(--sidebar-w);
    background: var(--surface);
    border-right: 1px solid var(--border);
    position: sticky; top: var(--header-h);
    height: calc(100vh - var(--header-h));
    overflow-y: auto;
    flex-shrink: 0;
    padding: 16px 0 32px;
  }
  .sidebar-section { margin-bottom: 8px; }
  .sidebar-heading {
    font-size: 0.7rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-muted);
    padding: 0 16px 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .sidebar a {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 16px;
    color: var(--text); text-decoration: none;
    font-size: 0.875rem; font-family: 'Courier New', monospace;
    border-left: 2px solid transparent;
    transition: background 80ms, border-color 80ms, color 80ms;
  }
  .sidebar a:hover   { background: rgba(255,255,255,.05); }
  .sidebar a.active  {
    background: rgba(74,158,218,.12);
    border-left-color: var(--accent);
    color: #fff;
  }

  /* ── Badges ── */
  .badge, .fn-kind, .const-badge, .export-badge {
    font-family: -apple-system, sans-serif;
    font-size: 0.65rem; font-weight: 700;
    padding: 1px 5px; border-radius: 3px;
    letter-spacing: 0.03em;
    display: inline-block; vertical-align: middle;
  }
  .badge.comptime, .fn-kind.comptime { background:#5a3d8a; color:#e0d0ff; }
  .badge.runtime,  .fn-kind.runtime  { background:#1d5c8a; color:#b8dcff; }
  .const-badge  { background: #5a3d8a; color: #e0d0ff; }
  .export-badge { background: #1e6b4a; color: #a0f0c0; }

  /* ── Main ── */
  main {
    flex: 1; min-width: 0;
    padding: 32px 40px 80px;
    max-width: 860px;
  }
  main h1 {
    font-size: 1.4rem; font-weight: 700; margin-bottom: 28px;
    color: var(--text); border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
  }

  /* ── Function entry ── */
  .fn-entry {
    margin-bottom: 40px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    scroll-margin-top: calc(var(--header-h) + 12px);
  }
  .fn-entry:target { border-color: var(--accent); }

  .fn-header {
    background: var(--surface2);
    padding: 10px 18px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px;
  }
  .fn-name {
    font-family: 'Courier New', monospace;
    font-size: 1rem; font-weight: 700;
    color: var(--fn-color);
    text-decoration: none;
  }
  .fn-name:hover { text-decoration: underline; }

  .fn-body { padding: 18px 20px; }

  /* ── Signature ── */
  .sig-block {
    font-family: 'Courier New', monospace;
    font-size: 0.9rem;
    background: #0d1117;
    border-radius: 4px;
    padding: 12px 16px;
    margin-bottom: 18px;
    overflow-x: auto;
    white-space: pre;
    line-height: 1.8;
  }
  .sk  { color: var(--kw-color);  }   /* keyword */
  .sn  { color: var(--fn-color);  }   /* fn name  */
  .st  { color: var(--ty-color);  }   /* type     */
  .sp  { color: var(--prm-color); }   /* param    */
  .ss  { color: var(--text-muted);}   /* symbol   */

  /* ── Description ── */
  .description { margin-bottom: 16px; line-height: 1.75; }
  .description p { margin-bottom: 8px; }

  /* ── Sections ── */
  .section { margin-top: 18px; }
  .section-title {
    font-size: 0.72rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-muted);
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 10px;
  }

  /* ── Params table ── */
  .params-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  .params-table td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .params-table tr:last-child td { border-bottom: none; }
  .pt-name code { color: var(--prm-color); font-family: 'Courier New', monospace; }
  .pt-type code { color: var(--ty-color);  font-family: 'Courier New', monospace; }
  .pt-desc { color: var(--text); }
  .pt-nodoc { color: var(--text-muted); }

  /* ── Returns ── */
  .returns-section code.ret-type {
    font-family: 'Courier New', monospace;
    color: var(--ty-color);
  }

  /* ── Examples ── */
  .example-block {
    font-family: 'Courier New', monospace;
    font-size: 0.875rem;
    background: #0d1117;
    border-radius: 4px;
    padding: 14px 16px;
    overflow-x: auto;
    white-space: pre;
    color: var(--text);
    line-height: 1.7;
  }

  /* ── No-doc notice ── */
  .no-doc { color: var(--text-muted); font-style: italic; font-size: 0.9rem; }

  /* ── Imports section ── */
  .imports-block {
    margin-bottom: 32px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .imports-header {
    background: var(--surface2);
    padding: 9px 18px;
    border-bottom: 1px solid var(--border);
    font-size: 0.75rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-muted);
  }
  .imports-list {
    padding: 10px 0;
    list-style: none;
  }
  .imports-list li {
    display: flex; align-items: center; gap: 10px;
    padding: 5px 18px;
    font-family: 'Courier New', monospace;
    font-size: 0.88rem;
  }
  .import-kw   { color: var(--kw-color); }
  .import-src  { color: var(--accent); }
  .import-alias{ color: var(--fn-color); }
  .import-kind-badge {
    font-family: sans-serif;
    font-size: 0.62rem; font-weight: 700;
    padding: 1px 5px; border-radius: 3px;
    background: #1d4060; color: #90cff5;
    letter-spacing: 0.04em;
  }
  .sidebar-import {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 16px;
    font-size: 0.8rem; font-family: 'Courier New', monospace;
    color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sidebar-import .import-src { font-size: 0.8rem; }

  /* ── Clickable import links ── */
  .import-link {
    text-decoration: none;
    border-bottom: 1px dashed var(--accent);
    transition: color 80ms, border-color 80ms;
  }
  .import-link:hover {
    color: #fff;
    border-bottom-color: #fff;
    border-bottom-style: solid;
  }
  .mod-link {
    display: flex; align-items: center;
    padding: 5px 16px;
    color: var(--text); text-decoration: none;
    font-size: 0.875rem; font-family: 'Courier New', monospace;
    border-left: 2px solid transparent;
    transition: background 80ms, border-color 80ms;
  }
  .mod-link:hover   { background: rgba(255,255,255,.05); }
  .mod-link.active  {
    background: rgba(74,158,218,.12);
    border-left-color: var(--accent);
    color: #fff;
  }

  /* ── Footer ── */
  footer {
    text-align: center;
    padding: 28px;
    font-size: 0.8rem;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
  }
  footer code { font-family: 'Courier New', monospace; color: var(--accent); }

  /* ── Scrollbar (Webkit) ── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
`;

// ── JavaScript (scroll-spy) ───────────────────────────────────────────────────

const JS = `
  const entries  = Array.from(document.querySelectorAll('.fn-entry[id]'));
  const navLinks = Array.from(document.querySelectorAll('.sidebar a[href^="#"]'));

  function setActive(id) {
    navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
  }

  const io = new IntersectionObserver(changes => {
    for (const c of changes) {
      if (c.isIntersecting) { setActive(c.target.id); break; }
    }
  }, { threshold: 0, rootMargin: '-10% 0px -80% 0px' });

  entries.forEach(e => io.observe(e));

  // Activate the first item on load if nothing else matches
  if (entries.length) setActive(entries[0].id);
`;

// ── Import section renderer ───────────────────────────────────────────────────

function renderImportSrc(imp: ImportDoc): string {
    const text = `"${esc(imp.source)}"`;
    if (imp.docHref) {
        return `<a class="import-src import-link" href="${esc(imp.docHref)}">${text}</a>`;
    }
    return `<span class="import-src">${text}</span>`;
}

function renderImports(imports: ImportDoc[]): string {
    if (imports.length === 0) return '';

    const items = imports.map(imp => {
        if (imp.kind === 'namespace') {
            // const g = import "./module"
            return `      <li>` +
                `<span class="import-kind-badge">ns</span>` +
                `<span class="import-kw">const</span> ` +
                `<span class="import-alias">${esc(imp.alias!)}</span> ` +
                `<span class="import-kw">= import</span> ` +
                renderImportSrc(imp) +
                `</li>`;
        }
        // import "./module"
        return `      <li>` +
            `<span class="import-kind-badge">bare</span>` +
            `<span class="import-kw">import</span> ` +
            renderImportSrc(imp) +
            `</li>`;
    }).join('\n');

    return `
    <div class="imports-block">
      <div class="imports-header">Imports</div>
      <ul class="imports-list">
${items}
      </ul>
    </div>`;
}

// ── Public entry point ────────────────────────────────────────────────────────

export function renderHtml(doc: ModuleDoc, version: string, ctx?: RenderContext): string {
    const baseName = path.basename(doc.sourceFile);

    // ── Sidebar: all modules (when multi-module docs) ─────────────────────────
    const sidebarModules = ctx?.allModules?.length
        ? `      <div class="sidebar-section">
        <div class="sidebar-heading">Modules</div>
${ctx.allModules.map(m =>
    m.isCurrent
        ? `        <a href="${esc(m.href)}" class="active mod-link">📄 ${esc(m.name)}</a>`
        : `        <a href="${esc(m.href)}" class="mod-link">📄 ${esc(m.name)}</a>`
).join('\n')}
      </div>`
        : '';

    // ── Sidebar: imports ──────────────────────────────────────────────────────
    const sidebarImports = doc.imports.length > 0
        ? `      <div class="sidebar-section">
        <div class="sidebar-heading">Imports</div>
${doc.imports.map(imp => {
    const srcHtml = imp.docHref
        ? `<a class="import-src import-link" href="${esc(imp.docHref)}">"${esc(imp.source)}"</a>`
        : `<span class="import-src">"${esc(imp.source)}"</span>`;
    return imp.kind === 'namespace'
        ? `        <div class="sidebar-import"><span class="import-kw">ns</span> <span class="import-alias">${esc(imp.alias!)}</span> = ${srcHtml}</div>`
        : `        <div class="sidebar-import">${srcHtml}</div>`;
}).join('\n')}
      </div>`
        : '';

    // ── Sidebar: functions ────────────────────────────────────────────────────
    const navItems = doc.functions.map(fn => {
        const kindClass = fn.isComptime ? 'comptime' : 'runtime';
        const kindLabel = fn.isComptime ? 'const fn' : 'fn';
        return `      <a href="#fn.${esc(fn.name)}">` +
            `<span class="badge ${kindClass}">${kindLabel}</span>` +
            `${esc(fn.name)}</a>`;
    }).join('\n');

    // ── Function entries ──────────────────────────────────────────────────────
    const fnCount   = doc.functions.length;
    const docCount  = doc.functions.filter(f => f.doc).length;
    const subtitle  = fnCount === 0
        ? 'No functions defined.'
        : `${fnCount} function${fnCount !== 1 ? 's' : ''}` +
          (docCount < fnCount ? ` · ${docCount} documented` : ' · all documented');

    const importsSection   = renderImports(doc.imports);
    const functionEntries  = doc.functions.map(renderFunctionEntry).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeLang Docs — ${esc(baseName)}</title>
  <style>${CSS}
  </style>
</head>
<body>

  <header>
    <span class="logo">codelang</span>
    <span class="logo-sep">/</span>
    <span class="source-filename">${esc(baseName)}</span>
  </header>

  <div class="layout">

    <nav class="sidebar">
${sidebarModules}
${sidebarImports}
      <div class="sidebar-section">
        <div class="sidebar-heading">Functions</div>
${navItems}
      </div>
    </nav>

    <main>
      <h1>${esc(baseName)} <small style="font-size:.75rem;font-weight:400;color:var(--text-muted)">${esc(subtitle)}</small></h1>
${importsSection}
${functionEntries}
    </main>

  </div>

  <footer>
    Generated by <code>codelang doc</code> &nbsp;·&nbsp; CodeLang ${esc(version)}
  </footer>

  <script>${JS}
  </script>

</body>
</html>`;
}
