#!/usr/bin/env node
/**
 * scripts/merge-syntax.mjs
 *
 * Run automatically after `langium generate` (via the `langium:generate` npm
 * script) to merge hand-crafted highlight rules back into the generated
 * TextMate grammar.
 *
 * Langium overwrites `syntaxes/codelang.tmLanguage.json` with a minimal
 * grammar that only contains keywords, strings, and comments.  This script
 * merges the custom `repository` entries and injects them into the `patterns`
 * array so that richer highlighting (type-parameters, type-annotations,
 * built-in types, …) is preserved across regenerations.
 *
 * Custom additions live in `syntaxes/codelang.custom.json`.  They follow the
 * same shape as the main grammar so the merge is a simple object-spread.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

const MAIN_PATH   = resolve(ROOT, 'syntaxes/codelang.tmLanguage.json');
const CUSTOM_PATH = resolve(ROOT, 'syntaxes/codelang.custom.json');

const main   = JSON.parse(readFileSync(MAIN_PATH,   'utf-8'));
const custom = JSON.parse(readFileSync(CUSTOM_PATH, 'utf-8'));

// Merge repository entries: custom wins on collision.
main.repository = { ...main.repository, ...custom.repository };

// Prepend custom top-level pattern includes so they fire before the generic
// keyword rule (order matters in TextMate grammars).
const existingIncludes = new Set((main.patterns ?? []).map(p => p.include));
const toAdd = (custom.topLevelIncludes ?? [])
    .filter(ref => !existingIncludes.has(ref))
    .map(ref => ({ include: ref }));

// Insert custom includes right after #comments (index 1) so they override
// the flat keyword rule while still deferring to the comment rule.
const commentsIdx = main.patterns.findIndex(p => p.include === '#comments');
main.patterns.splice(commentsIdx + 1, 0, ...toAdd);

writeFileSync(MAIN_PATH, JSON.stringify(main, null, 2) + '\n');
console.log(`[merge-syntax] merged ${toAdd.length} custom pattern(s) into ${MAIN_PATH}`);
