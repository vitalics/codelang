/**
 * stdlib/fs tests — File, Dir, Path
 *
 * Exercises the full filesystem API introduced in stdlib/fs.code:
 *
 *   Path — join, dirname, basename, stem, extname, isAbsolute, sep, delimiter
 *   Dir  — createAll, isDir, exists, removeAll, temp
 *   File — write, read, size, exists, isFile, append, copy, touch, delete, stat
 *   FileStat — isFile, isDir fields
 *
 * All I/O happens inside a fresh subdirectory of Dir.temp() so the test
 * leaves no permanent changes on the filesystem.
 *
 * Fixture: tests/fixtures/valid/fs_basic.code
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

// ── Fixture output ────────────────────────────────────────────────────────────

let lines:    string[]    = [];
let exitCode: number|null = null;

// Output index → expected value (see comments in fs_basic.code):
//  0  /usr/local/bin
//  1  /usr/local
//  2  bin
//  3  file.tar
//  4  .gz
//  5  ""              (empty — no extension for "Makefile")
//  6  true
//  7  false
//  8  /
//  9  :
// 10  true            Dir.createAll
// 11  true            Dir.isDir
// 12  true            File.write
// 13  Hello, World!
// 14  13              File.size
// 15  true            File.exists
// 16  true            File.isFile
// 17  true            File.append (write l1)
// 18  Hello, World!   File.read l1
// 19  true            File.write l2
// 20  Second line     File.read l2
// 21  true            File.copy
// 22  Hello, World!   File.read copy reuse
// 23  true            FileStat.isFile
// 24  false           FileStat.isDir
// 25  true            File.touch
// 26  0               File.size empty
// 27  true            File.delete copy
// 28  false           File.exists deleted
// 29  false           Dir.exists after removeAll

beforeAll(() => {
    const result = compileAndRun('fs_basic.code');
    exitCode     = result.exitCode;
    lines        = result.stdout.trim().split('\n');
}, 300_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('fs_basic — compilation', () => {
    it('compiles and exits 0',       () => expect(exitCode).toBe(0));
    it('produces 30 output lines',   () => expect(lines).toHaveLength(30));
});

// ── Path — pure string manipulation ──────────────────────────────────────────

describe('Path — join / decomposition', () => {
    it('join("/usr/local", "bin") === "/usr/local/bin"',  () => expect(lines[0]).toBe('/usr/local/bin'));
    it('dirname("/usr/local/bin") === "/usr/local"',      () => expect(lines[1]).toBe('/usr/local'));
    it('basename("/usr/local/bin") === "bin"',            () => expect(lines[2]).toBe('bin'));
    it('stem("file.tar.gz") === "file.tar"',              () => expect(lines[3]).toBe('file.tar'));
    it('extname("file.tar.gz") === ".gz"',                () => expect(lines[4]).toBe('.gz'));
    it('extname("Makefile") === ""',                      () => expect(lines[5]).toBe(''));
});

describe('Path — predicates & constants', () => {
    it('isAbsolute("/etc") === true',   () => expect(lines[6]).toBe('true'));
    it('isAbsolute("rel") === false',   () => expect(lines[7]).toBe('false'));
    it('sep() === "/"',                 () => expect(lines[8]).toBe('/'));
    it('delimiter() === ":"',           () => expect(lines[9]).toBe(':'));
});

// ── Dir ───────────────────────────────────────────────────────────────────────

describe('Dir — createAll / isDir', () => {
    it('createAll returns true',  () => expect(lines[10]).toBe('true'));
    it('isDir returns true',      () => expect(lines[11]).toBe('true'));
});

// ── File — write / read / size ────────────────────────────────────────────────

describe('File — write / read / size / exists / isFile', () => {
    it('write returns true',              () => expect(lines[12]).toBe('true'));
    it('read returns "Hello, World!"',    () => expect(lines[13]).toBe('Hello, World!'));
    it('size returns 13',                 () => expect(lines[14]).toBe('13'));
    it('exists returns true',             () => expect(lines[15]).toBe('true'));
    it('isFile returns true',             () => expect(lines[16]).toBe('true'));
});

// ── File — append ─────────────────────────────────────────────────────────────

describe('File — append', () => {
    it('write l1 returns true',        () => expect(lines[17]).toBe('true'));
    it('read l1 === "Hello, World!"',  () => expect(lines[18]).toBe('Hello, World!'));
    it('write l2 returns true',        () => expect(lines[19]).toBe('true'));
    it('read l2 === "Second line"',    () => expect(lines[20]).toBe('Second line'));
});

// ── File — copy ───────────────────────────────────────────────────────────────

describe('File — copy', () => {
    it('copy returns true',                     () => expect(lines[21]).toBe('true'));
    it('read of copy === "Hello, World!"',      () => expect(lines[22]).toBe('Hello, World!'));
});

// ── FileStat ──────────────────────────────────────────────────────────────────

describe('FileStat — isFile / isDir', () => {
    it('stat.isFile === true',   () => expect(lines[23]).toBe('true'));
    it('stat.isDir === false',   () => expect(lines[24]).toBe('false'));
});

// ── File — touch / delete ─────────────────────────────────────────────────────

describe('File — touch / delete', () => {
    it('touch returns true',        () => expect(lines[25]).toBe('true'));
    it('size of empty === 0',       () => expect(lines[26]).toBe('0'));
    it('delete returns true',       () => expect(lines[27]).toBe('true'));
    it('exists after delete false', () => expect(lines[28]).toBe('false'));
});

// ── Dir — removeAll ───────────────────────────────────────────────────────────

describe('Dir — removeAll', () => {
    it('dir does not exist after removeAll', () => expect(lines[29]).toBe('false'));
});
