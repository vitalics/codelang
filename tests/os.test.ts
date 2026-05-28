/**
 * Tests for stdlib/os.code — OS namespace.
 *
 * Covers:
 *  1. Compile-time constants  (arch, platform, endianness, eol, devNull)
 *  2. OS identity             (osType, release)
 *  3. Machine                 (hostname, homedir, tmpdir, uptime)
 *  4. Memory                  (totalmem, freemem — positive, total > free)
 *  5. CPU                     (cpuCount, cpuModel, cpuSpeed)
 *  6. User                    (username, uid, gid)
 *  7. GPU                     (gpuCount, gpuModel)
 *  8. NPU                     (hasNpu, npuName)
 *  9. Sanity cross-checks     (idempotency, total > free, etc.)
 * 10. IR structure             (extern declarations)
 *
 * Most values are machine-dependent; tests check structural invariants
 * (valid set membership, positive ranges, non-empty strings) rather than
 * exact values so the suite passes on any supported platform.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'os_basic.code';

const KNOWN_ARCHES    = ['arm64', 'x64', 'x86', 'arm', 'riscv64', 'unknown'];
const KNOWN_PLATFORMS = ['darwin', 'linux', 'win32', 'freebsd', 'unknown'];

let out:      string[]    = [];
let ir:       string      = '';
let exitCode: number|null = null;

beforeAll(() => {
    const r  = compileAndRun(FIXTURE);
    exitCode = r.exitCode;
    out      = r.stdout.trim().split('\n').map(l => l.trim());
    ir       = r.ir;
});

// =============================================================================
// 1. Compile-time constants
// =============================================================================

describe('OS — compile-time constants', () => {

    it('exits with code 0', () => {
        expect(exitCode).toBe(0);
    });

    it('arch() returns a known architecture string', () => {
        expect(KNOWN_ARCHES).toContain(out[0]);
    });

    it('platform() returns a known platform string', () => {
        expect(KNOWN_PLATFORMS).toContain(out[1]);
    });

    it('endianness() is "LE" or "BE"', () => {
        expect(['LE', 'BE']).toContain(out[2]);
    });

    it('eol() has length 1 (POSIX) or 2 (Windows)', () => {
        expect(['1', '2']).toContain(out[3]);
    });

    it('devNull() is "/dev/null" or Windows NUL path', () => {
        const v = out[4];
        expect(v.length).toBeGreaterThan(0);
        // POSIX: /dev/null    Windows: \\.\NUL
        expect(v === '/dev/null' || v.includes('NUL')).toBe(true);
    });

    it('IR: declares @os_arch extern', () => {
        expect(ir).toMatch(/declare i8\* @os_arch\(\)/);
    });

    it('IR: declares @os_platform extern', () => {
        expect(ir).toMatch(/declare i8\* @os_platform\(\)/);
    });

    it('IR: declares @os_endianness extern', () => {
        expect(ir).toMatch(/declare i8\* @os_endianness\(\)/);
    });

    it('IR: declares @os_eol extern', () => {
        expect(ir).toMatch(/declare i8\* @os_eol\(\)/);
    });

    it('IR: declares @os_dev_null extern', () => {
        expect(ir).toMatch(/declare i8\* @os_dev_null\(\)/);
    });

});

// =============================================================================
// 2. OS identity
// =============================================================================

describe('OS — OS identity', () => {

    it('osType() returns a non-empty string', () => {
        expect(out[5].length).toBeGreaterThan(0);
    });

    it('release() length > 0', () => {
        expect(out[6]).toBe('true');
    });

    it('IR: declares @os_type extern', () => {
        expect(ir).toMatch(/declare i8\* @os_type\(\)/);
    });

    it('IR: declares @os_release extern', () => {
        expect(ir).toMatch(/declare i8\* @os_release\(\)/);
    });

    it('IR: declares @os_version extern', () => {
        expect(ir).toMatch(/declare i8\* @os_version\(\)/);
    });

});

// =============================================================================
// 3. Machine
// =============================================================================

describe('OS — machine', () => {

    it('hostname() length > 0', () => {
        expect(out[7]).toBe('true');
    });

    it('homedir() length > 0', () => {
        expect(out[8]).toBe('true');
    });

    it('tmpdir() length > 0', () => {
        expect(out[9]).toBe('true');
    });

    it('uptime() > 0 (system has been running)', () => {
        expect(out[10]).toBe('true');
    });

    it('IR: declares @os_hostname extern', () => {
        expect(ir).toMatch(/declare i8\* @os_hostname\(\)/);
    });

    it('IR: declares @os_uptime returning i64', () => {
        expect(ir).toMatch(/declare i64 @os_uptime\(\)/);
    });

});

// =============================================================================
// 4. Memory
// =============================================================================

describe('OS — memory', () => {

    it('totalmem() > 0', () => {
        expect(out[11]).toBe('true');
    });

    it('freemem() > 0', () => {
        expect(out[12]).toBe('true');
    });

    it('totalmem() > freemem() (sanity check)', () => {
        expect(out[24]).toBe('true');
    });

    it('IR: declares @os_totalmem returning i64', () => {
        expect(ir).toMatch(/declare i64 @os_totalmem\(\)/);
    });

    it('IR: declares @os_freemem returning i64', () => {
        expect(ir).toMatch(/declare i64 @os_freemem\(\)/);
    });

});

// =============================================================================
// 5. CPU
// =============================================================================

describe('OS — CPU', () => {

    it('cpuCount() > 0', () => {
        expect(out[13]).toBe('true');
    });

    it('cpuModel() length > 0', () => {
        expect(out[14]).toBe('true');
    });

    it('cpuSpeed() >= 0 (0 = unavailable, e.g. Apple Silicon)', () => {
        expect(out[15]).toBe('true');
    });

    it('cpuCount() >= 1 (redundant guard)', () => {
        expect(out[26]).toBe('true');
    });

    it('IR: declares @os_cpu_count returning i32', () => {
        expect(ir).toMatch(/declare i32 @os_cpu_count\(\)/);
    });

    it('IR: declares @os_cpu_model returning i8*', () => {
        expect(ir).toMatch(/declare i8\* @os_cpu_model\(\)/);
    });

    it('IR: declares @os_cpu_speed returning i32', () => {
        expect(ir).toMatch(/declare i32 @os_cpu_speed\(\)/);
    });

});

// =============================================================================
// 6. User
// =============================================================================

describe('OS — user', () => {

    it('username() length > 0', () => {
        expect(out[16]).toBe('true');
    });

    it('uid() >= 0', () => {
        expect(out[17]).toBe('true');
    });

    it('gid() >= 0', () => {
        expect(out[18]).toBe('true');
    });

    it('IR: declares @os_username returning i8*', () => {
        expect(ir).toMatch(/declare i8\* @os_username\(\)/);
    });

    it('IR: declares @os_uid returning i32', () => {
        expect(ir).toMatch(/declare i32 @os_uid\(\)/);
    });

    it('IR: declares @os_gid returning i32', () => {
        expect(ir).toMatch(/declare i32 @os_gid\(\)/);
    });

});

// =============================================================================
// 7. GPU (OS namespace)
// =============================================================================

describe('OS — GPU', () => {

    it('gpuCount() >= 0', () => {
        expect(out[19]).toBe('true');
    });

    it('gpuModel(0) returns a non-empty string', () => {
        expect(out[20]).toBe('true');
    });

    it('IR: declares @os_gpu_count returning i32', () => {
        expect(ir).toMatch(/declare i32 @os_gpu_count\(\)/);
    });

    it('IR: declares @os_gpu_model(i32) returning i8*', () => {
        expect(ir).toMatch(/declare i8\* @os_gpu_model\(i32\)/);
    });

});

// =============================================================================
// 8. NPU / Neural Engine (OS namespace)
// =============================================================================

describe('OS — NPU', () => {

    it('hasNpu() returns a valid boolean', () => {
        expect(['true', 'false']).toContain(out[21]);
    });

    it('npuName() length > 0', () => {
        expect(out[22]).toBe('true');
    });

    it('IR: declares @os_has_npu returning i32', () => {
        expect(ir).toMatch(/declare i32 @os_has_npu\(\)/);
    });

    it('IR: declares @os_npu_name returning i8*', () => {
        expect(ir).toMatch(/declare i8\* @os_npu_name\(\)/);
    });

});

// =============================================================================
// 11. GPU sub-namespace
// =============================================================================

describe('GPU — sub-namespace', () => {

    it('GPU.isAvailable() returns a valid boolean (compile-time)', () => {
        expect(['true', 'false']).toContain(out[30]);
    });

    it('GPU.count() >= 0', () => {
        expect(out[31]).toBe('true');
    });

    it('GPU.model(0) returns a non-empty string', () => {
        expect(out[32]).toBe('true');
    });

    it('IR: declares @os_gpu_is_available returning i32', () => {
        expect(ir).toMatch(/declare i32 @os_gpu_is_available\(\)/);
    });

});

// =============================================================================
// 12. NPU sub-namespace
// =============================================================================

describe('NPU — sub-namespace', () => {

    it('NPU.isAvailable() returns a valid boolean (compile-time)', () => {
        expect(['true', 'false']).toContain(out[33]);
    });

    it('NPU.name() returns a non-empty string', () => {
        expect(out[34]).toBe('true');
    });

    it('IR: declares @os_npu_is_available returning i32', () => {
        expect(ir).toMatch(/declare i32 @os_npu_is_available\(\)/);
    });

});

// =============================================================================
// 9. Sanity / cross-checks
// =============================================================================

describe('OS — sanity checks', () => {

    it('arch() is idempotent — two calls return same value', () => {
        expect(out[23]).toBe('true');
    });

    it('platform() length > 0', () => {
        expect(out[25]).toBe('true');
    });

    it('endianness() length == 2  ("LE" or "BE" — exactly two characters)', () => {
        expect(out[27]).toBe('true');
    });

    it('eol() length >= 1', () => {
        expect(out[28]).toBe('true');
    });

    it('devNull() length > 0', () => {
        expect(out[29]).toBe('true');
    });

});

// =============================================================================
// 10. Overall
// =============================================================================

describe('OS — overall', () => {

    it('produces exactly 35 lines of output', () => {
        expect(out).toHaveLength(35);
    });

});
