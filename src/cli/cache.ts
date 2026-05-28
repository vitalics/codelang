/**
 * Build cache for the CodeLang compiler.
 *
 * Cache key = SHA-256(source file bytes) + compiler version.
 * Metadata is stored as a small JSON file next to the compiled binary:
 *   <baseName>.codelang-cache
 *
 * The binary is considered fresh when:
 *   1. The binary file itself exists.
 *   2. The .codelang-cache file exists alongside it.
 *   3. Both the source hash and compiler version in the metadata match.
 */

import * as crypto from 'node:crypto';
import * as fs   from 'node:fs';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CacheMeta {
    sourceHash:      string;
    compilerVersion: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** SHA-256 hex digest of the given file's contents. */
export function hashFile(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Absolute path of the cache-metadata file for a given binary. */
export function metaPath(exeFile: string): string {
    return `${exeFile}.codelang-cache`;
}

/**
 * Returns true when the binary is up-to-date:
 * binary + cache file both exist, and both hash + version match.
 */
export function isFresh(
    exeFile:         string,
    sourceHash:      string,
    compilerVersion: string,
): boolean {
    if (!fs.existsSync(exeFile))          return false;
    if (!fs.existsSync(metaPath(exeFile))) return false;

    try {
        const meta = JSON.parse(
            fs.readFileSync(metaPath(exeFile), 'utf-8')
        ) as CacheMeta;
        return (
            meta.sourceHash      === sourceHash &&
            meta.compilerVersion === compilerVersion
        );
    } catch {
        return false;
    }
}

/** Persist cache metadata after a successful compilation. */
export function save(
    exeFile:         string,
    sourceHash:      string,
    compilerVersion: string,
): void {
    const meta: CacheMeta = { sourceHash, compilerVersion };
    fs.writeFileSync(metaPath(exeFile), JSON.stringify(meta, null, 2) + '\n');
}
