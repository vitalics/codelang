import chalk from 'chalk';
import { Command } from 'commander';
import { NodeFileSystem } from 'langium/node';
import * as url from 'node:url';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createCodeLangServices } from '../language/codelang-module.js';
import { generateLLVMIR } from './ir-generator/index.js';
import { hashFile, isFresh, save } from './cache.js';
import { resolveModuleGraph, resolveModulePath, ModuleResolutionError, CyclicDependencyError } from './module-resolver/index.js';
import { formatIRError } from './error-format.js';
import { buildModuleDoc, renderHtml } from './doc-generator/index.js';
import type { RenderContext } from './doc-generator/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
const pkgVersion: string = JSON.parse(await fsp.readFile(pkgPath, 'utf-8')).version as string;

function resolveClang(): string {
    const isWindows = process.platform === 'win32';

    const candidates: string[] = isWindows
        ? [
              // LLVM official Windows installer default location
              'C:\\Program Files\\LLVM\\bin\\clang.exe',
              'C:\\Program Files (x86)\\LLVM\\bin\\clang.exe',
              // Respect %ProgramFiles% (handles non-default install drives)
              ...(process.env['ProgramFiles']
                  ? [path.join(process.env['ProgramFiles'], 'LLVM', 'bin', 'clang.exe')]
                  : []),
              // Scoop package manager: %USERPROFILE%\scoop\apps\llvm\current\bin\clang.exe
              ...(process.env['USERPROFILE']
                  ? [path.join(process.env['USERPROFILE'], 'scoop', 'apps', 'llvm', 'current', 'bin', 'clang.exe')]
                  : []),
          ]
        : [
              '/usr/bin/clang',
              '/opt/homebrew/opt/llvm@14/bin/clang',
              '/usr/local/opt/llvm@14/bin/clang',
          ];

    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    // Fall back to whatever is on PATH
    return isWindows ? 'clang.exe' : 'clang';
}

// ── Compile action ────────────────────────────────────────────────────────────

export interface CompileOptions {
    destination?: string;
    run?:         boolean;
    ir?:          boolean;   // emit IR only, skip clang
    noCache?:     boolean;   // force full rebuild
    cpath?:       string;    // explicit path to the clang binary
    debug?:       boolean;   // emit DWARF debug info (-g)
    extraC?:      string[];  // additional C files appended to the clang invocation
}

export async function compileAction(fileName: string, opts: CompileOptions): Promise<void> {
    const absFile = path.resolve(fileName);
    const baseName = path.basename(fileName, path.extname(fileName));
    const outDir   = opts.destination ?? path.dirname(absFile);

    fs.mkdirSync(outDir, { recursive: true });

    const exeExt  = process.platform === 'win32' ? '.exe' : '';
    const exeFile = path.join(outDir, baseName + exeExt);

    // ── Cache check ──────────────────────────────────────────────────────────
    if (!opts.ir && !opts.noCache) {
        const hash = hashFile(absFile);
        if (isFresh(exeFile, hash, pkgVersion)) {
            console.log(chalk.dim(`  cached  ${exeFile}`));
            if (opts.run) {
                console.log(chalk.dim(`\n──── output ────`));
                const result = spawnSync(exeFile, [], { stdio: 'inherit' });
                process.exit(result.status ?? 0);
            }
            return;
        }
    }

    // ── Parse + resolve imports ───────────────────────────────────────────────
    const services = createCodeLangServices(NodeFileSystem).CodeLang;

    let moduleGraph;
    try {
        moduleGraph = await resolveModuleGraph(fileName, services);
    } catch (err) {
        if (err instanceof ModuleResolutionError || err instanceof CyclicDependencyError) {
            console.error(chalk.red(`Module error: ${err.message}`));
            process.exit(1);
        }
        throw err;
    }

    // ── 1. Generate LLVM IR ──────────────────────────────────────────────────
    const llFile = path.join(outDir, `${baseName}.ll`);
    let ir: string;
    try {
        ir = generateLLVMIR(moduleGraph.modules, path.basename(fileName), {
            debug: opts.debug,
            sourceFilePath: opts.debug ? absFile : undefined,
        });
    } catch (err) {
        console.error(formatIRError((err as Error).message));
        process.exit(1);
    }
    fs.writeFileSync(llFile, ir);
    console.log(chalk.cyan(`  ir  →  ${llFile}`));

    if (opts.ir) return;

    // ── 2. Compile with clang ────────────────────────────────────────────────
    let clang: string;
    if (opts.cpath) {
        if (!fs.existsSync(opts.cpath)) {
            console.error(chalk.red(`✗  --cpath: file not found: ${opts.cpath}`));
            process.exit(1);
        }
        clang = opts.cpath;
        console.log(chalk.dim(`  clang →  ${clang}`));
    } else {
        clang = resolveClang();
    }

    // Number runtime — always linked so %Number* references resolve.
    const runtimeC = path.resolve(__dirname, '..', '..', 'runtime', 'number.c');

    const runtimeStringC      = path.resolve(__dirname, '..', '..', 'runtime', 'string.c');
    const runtimeArrayC       = path.resolve(__dirname, '..', '..', 'runtime', 'array.c');
    const runtimeSetC         = path.resolve(__dirname, '..', '..', 'runtime', 'set.c');
    const runtimeMapC         = path.resolve(__dirname, '..', '..', 'runtime', 'map.c');
    const runtimeReflectionC  = path.resolve(__dirname, '..', '..', 'runtime', 'reflection.c');
    const runtimeStacktraceC  = path.resolve(__dirname, '..', '..', 'runtime', 'stacktrace.c');
    const runtimeIoC          = path.resolve(__dirname, '..', '..', 'runtime', 'io.c');
    const runtimeMathC        = path.resolve(__dirname, '..', '..', 'runtime', 'math.c');
    const runtimeRandomC      = path.resolve(__dirname, '..', '..', 'runtime', 'random.c');
    const runtimeSimdC        = path.resolve(__dirname, '..', '..', 'runtime', 'simd.c');
    const runtimeNpuC         = path.resolve(__dirname, '..', '..', 'runtime', 'npu.c');
    const runtimeNpuCoremlC   = path.resolve(__dirname, '..', '..', 'runtime', 'npu_coreml.c');
    const runtimeFsC          = path.resolve(__dirname, '..', '..', 'runtime', 'fs.c');
    const runtimeOsC          = path.resolve(__dirname, '..', '..', 'runtime', 'os.c');
    const runtimeTuiC         = path.resolve(__dirname, '..', '..', 'runtime', 'tui.c');
    const runtimeAsyncC       = path.resolve(__dirname, '..', '..', 'runtime', 'async.c');
    const runtimeStreamC      = path.resolve(__dirname, '..', '..', 'runtime', 'stream.c');
    const runtimeNetTcpC      = path.resolve(__dirname, '..', '..', 'runtime', 'net_tcp.c');
    const runtimeNetDnsC      = path.resolve(__dirname, '..', '..', 'runtime', 'net_dns.c');
    const runtimeNetUdpC      = path.resolve(__dirname, '..', '..', 'runtime', 'net_udp.c');
    const runtimeNetHttpC     = path.resolve(__dirname, '..', '..', 'runtime', 'net_http.c');
    const runtimeNetWsC       = path.resolve(__dirname, '..', '..', 'runtime', 'net_ws.c');
    const runtimeNetHttp2C    = path.resolve(__dirname, '..', '..', 'runtime', 'net_http2.c');
    const runtimeNetHttp3C    = path.resolve(__dirname, '..', '..', 'runtime', 'net_http3.c');
    const runtimeDateC        = path.resolve(__dirname, '..', '..', 'runtime', 'date.c');
    const runtimeNetUriC      = path.resolve(__dirname, '..', '..', 'runtime', 'net_uri.c');
    const runtimeNetServerC   = path.resolve(__dirname, '..', '..', 'runtime', 'net_server.c');
    // Resolve SDK path once (macOS only) — used for both compile and link steps.
    let sdkPath: string | undefined;
    if (process.platform === 'darwin') {
        const sdkResult = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf-8' });
        if (sdkResult.status === 0 && sdkResult.stdout.trim()) {
            sdkPath = sdkResult.stdout.trim();
        }
    }

    // ── 2a. macOS debug: pre-compile .ll → .o so dsymutil can find it ────────
    // On macOS, clang uses a "debug map" format: debug info lives in .o files
    // referenced by the final binary. If we let clang do everything in one pass,
    // those .o files end up in /var/folders/… and are deleted before dsymutil
    // runs. Compiling to a persistent .o in outDir fixes this.
    let userObjFile: string | undefined;
    if (opts.debug && process.platform === 'darwin') {
        userObjFile = path.join(outDir, baseName + '.o');
        const compileArgs = ['-c', '-g', llFile, '-o', userObjFile];
        if (sdkPath) compileArgs.push('-isysroot', sdkPath);
        const compileResult = spawnSync(clang, compileArgs, { stdio: 'pipe' });
        if (compileResult.status !== 0) {
            const msg = (compileResult.stderr?.toString() ?? '') + (compileResult.stdout?.toString() ?? '');
            console.error(chalk.red(`✗  clang -c failed:\n${msg.trim()}`));
            process.exit(1);
        }
    }

    // ── 2b. Link ─────────────────────────────────────────────────────────────
    // When we pre-compiled the user code to a .o, use that instead of the .ll.
    const clangArgs = [
        userObjFile ?? llFile,
        runtimeC, runtimeStringC, runtimeArrayC, runtimeSetC, runtimeMapC,
        runtimeReflectionC, runtimeStacktraceC, runtimeIoC, runtimeMathC,
        runtimeRandomC, runtimeSimdC, runtimeNpuC, runtimeNpuCoremlC,
        runtimeFsC, runtimeOsC, runtimeTuiC, runtimeAsyncC, runtimeStreamC,
        runtimeNetTcpC, runtimeNetDnsC, runtimeNetUdpC, runtimeNetHttpC,
        runtimeNetWsC, runtimeNetHttp2C, runtimeNetHttp3C, runtimeDateC,
        runtimeNetUriC, runtimeNetServerC,
        ...(opts.extraC ?? []),
        '-o', exeFile,
    ];
    if (opts.debug) {
        clangArgs.push('-g');
        // Debug builds stay at -O0 so variables are not optimised away and
        // source locations remain accurate in the debugger.
    } else {
        // Release builds: -O2 gives Rust/Go-level performance.
        // The generated LLVM IR uses alloca + load/store patterns (mem-to-reg
        // form) that LLVM's -O2 pipeline (mem2reg, instcombine, GVN, loop opts,
        // inlining) fully optimises — bringing CodeLang to parity with Rust.
        clangArgs.push('-O2');
    }
    if (sdkPath) {
        clangArgs.push('-isysroot', sdkPath);
        // Link Accelerate framework for hardware-accelerated matrix ops (AMX / ANE).
        clangArgs.push('-framework', 'Accelerate');
        // Link CoreML + Foundation for stdlib/npu/apple_coreml.code.
        clangArgs.push('-framework', 'CoreML', '-framework', 'Foundation');
    }
    // Linux: pthreads is a separate library (already in libc on macOS).
    if (process.platform === 'linux') {
        clangArgs.push('-lpthread');
    }

    const clangResult = spawnSync(clang, clangArgs, { stdio: 'inherit' });

    if (clangResult.status !== 0) {
        console.error(chalk.red(`✗  clang failed (exit ${clangResult.status ?? '?'})`));
        process.exit(1);
    }
    console.log(chalk.green(`  bin →  ${exeFile}`));

    // ── 2c. Bundle DWARF into a .dSYM (macOS debug builds) ───────────────────
    // Now that the .o file is in outDir and still present, dsymutil can read it.
    if (opts.debug && process.platform === 'darwin') {
        const dsymResult = spawnSync('dsymutil', [exeFile], { stdio: 'pipe' });
        const dsymStderr = dsymResult.stderr?.toString() ?? '';
        if (dsymResult.status !== 0 || dsymStderr.includes('error:')) {
            console.error(chalk.yellow(`  warn: dsymutil failed — breakpoints may not resolve\n${dsymStderr.trim()}`));
        } else {
            console.log(chalk.dim(`  dbg →  ${exeFile}.dSYM`));
        }
    }

    // ── 3. Save cache ────────────────────────────────────────────────────────
    save(exeFile, hashFile(absFile), pkgVersion);

    // ── 4. Optionally run ────────────────────────────────────────────────────
    if (opts.run) {
        console.log(chalk.dim(`\n──── output ────`));
        const result = spawnSync(exeFile, [], { stdio: 'inherit' });
        process.exit(result.status ?? 0);
    }
}

// ── Build action ─────────────────────────────────────────────────────────────

export interface BuildOptions {
    script?:   string;   // path to build.code  (default: ./build.code)
    optimize?: string;   // Debug | ReleaseSafe | ReleaseFast | ReleaseSmall
    prefix?:   string;   // install prefix (default: build)
    list?:     boolean;  // list available steps instead of executing
}

export async function buildAction(stepName: string | undefined, opts: BuildOptions): Promise<void> {
    const script = opts.script ?? 'build.code';
    if (!fs.existsSync(script)) {
        console.error(chalk.red(`✗  build script not found: ${script}`));
        console.error(chalk.dim('  Create a build.code in your project root.'));
        process.exit(1);
    }

    // ── 1. Compile build.code → native binary ─────────────────────────────
    const tmpDir = path.join(os.tmpdir(), `codelang-build-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const runtimeBuildC = path.resolve(__dirname, '..', '..', 'runtime', 'build.c');

    console.log(chalk.cyan(`  build  →  compiling ${script} …`));
    await compileAction(script, {
        destination: tmpDir,
        noCache:     true,
        extraC:      [runtimeBuildC],
    });

    // ── 2. Run the build binary ────────────────────────────────────────────
    const baseName = path.basename(script, '.code');
    const exeExt   = process.platform === 'win32' ? '.exe' : '';
    const buildBin = path.join(tmpDir, baseName + exeExt);

    const codelangBin  = path.resolve(__dirname, '..', '..', 'bin', 'codelang.js');
    const codelangNode = process.execPath;  // the node binary running this script

    const runArgs: string[] = [];
    if (stepName)    runArgs.push(stepName);
    if (opts.list)   runArgs.push('--list');
    if (opts.optimize) runArgs.push('--optimize', opts.optimize);
    if (opts.prefix)   runArgs.push('--prefix',   opts.prefix);

    const result = spawnSync(buildBin, runArgs, {
        stdio: 'inherit',
        env:   {
            ...process.env,
            CODELANG_BIN:  codelangBin,
            CODELANG_NODE: codelangNode,
        },
    });

    process.exit(result.status ?? 0);
}

// ── Doc action ────────────────────────────────────────────────────────────────

export interface DocOptions {
    out?: string;   // output directory (default: ./docs)
}

export async function docAction(fileName: string, opts: DocOptions): Promise<void> {
    const absEntry = path.resolve(fileName);
    const entryDir = path.dirname(absEntry);
    const outDir   = path.resolve(opts.out ?? './docs');

    // ── Resolve full module graph ─────────────────────────────────────────────
    const services = createCodeLangServices(NodeFileSystem).CodeLang;

    let moduleGraph;
    try {
        moduleGraph = await resolveModuleGraph(fileName, services);
    } catch (err) {
        if (err instanceof ModuleResolutionError || err instanceof CyclicDependencyError) {
            console.error(chalk.red(`Module error: ${err.message}`));
            process.exit(1);
        }
        throw err;
    }

    fs.mkdirSync(outDir, { recursive: true });

    // ── Assign HTML filename to every module ──────────────────────────────────
    // Use path relative to entry dir, with '/' → '_', so sibling modules keep
    // their full path context and name collisions are avoided.
    function moduleHtmlFilename(filePath: string): string {
        const rel = path.relative(entryDir, filePath);            // e.g. "math/utils.code"
        return rel.replace(/[\\/]/g, '_').replace(/\.code$/, '') + '.html';
    }

    // absPath → html filename  (e.g. "/project/utils.code" → "utils.html")
    const htmlNameFor = new Map<string, string>();
    for (const mod of moduleGraph.modules) {
        htmlNameFor.set(mod.filePath, moduleHtmlFilename(mod.filePath));
    }

    // ── Context: sidebar module list ──────────────────────────────────────────
    const allModules = moduleGraph.modules.map(mod => ({
        name:      path.basename(mod.filePath, '.code'),
        href:      htmlNameFor.get(mod.filePath)!,
        isCurrent: false, // will be overridden per page below
    }));

    // ── Generate one HTML page per module ─────────────────────────────────────
    let totalFn = 0, totalDoc = 0;
    const written: string[] = [];

    for (const mod of moduleGraph.modules) {
        const source = fs.readFileSync(mod.filePath, 'utf-8');

        // Build "importSource → htmlFilename" map for this module's imports.
        // Each import spec (e.g. "./utils") is resolved to its absolute path,
        // then looked up in htmlNameFor to find its doc page.
        const importHrefs = new Map<string, string>();
        for (const elem of mod.program.elements) {
            let src: string | undefined;
            if ('source' in elem && typeof (elem as { source: string }).source === 'string') {
                src = (elem as { source: string }).source;
            }
            if (!src) continue;
            try {
                const depAbs  = resolveModulePath(src, path.dirname(mod.filePath));
                const depHtml = htmlNameFor.get(depAbs);
                if (depHtml) importHrefs.set(src, depHtml);
            } catch { /* unresolvable import — leave without href */ }
        }

        const moduleDoc = buildModuleDoc(mod.program, source, mod.filePath, importHrefs);

        const ctx: RenderContext = {
            allModules: allModules.map(m => ({
                ...m,
                isCurrent: m.href === htmlNameFor.get(mod.filePath),
            })),
        };

        const html    = renderHtml(moduleDoc, pkgVersion, ctx);
        const outFile = path.join(outDir, htmlNameFor.get(mod.filePath)!);
        fs.writeFileSync(outFile, html, 'utf-8');

        const fnCount  = moduleDoc.functions.length;
        const docCount = moduleDoc.functions.filter(f => f.doc !== null).length;
        totalFn  += fnCount;
        totalDoc += docCount;
        written.push(outFile);

        console.log(
            chalk.green(`  docs →  ${outFile}`) +
            chalk.dim(`  (${fnCount} fn, ${docCount} documented)`)
        );
    }

    if (written.length > 1) {
        console.log(chalk.dim(
            `\n  ${written.length} modules · ${totalFn} functions · ${totalDoc} documented`
        ));
    }
}

// ── CLI setup ─────────────────────────────────────────────────────────────────

export default function main(): void {
    const program = new Command();
    program
        .name('codelang')
        .description('CodeLang compiler')
        .version(pkgVersion);

    program
        .command('compile <file>')
        .description('Compile a .code file to a native binary')
        .option('-d, --destination <dir>', 'output directory (default: same as source)')
        .option('--ir',            'emit LLVM IR only, skip clang compilation')
        .option('--no-cache',      'force full rebuild even if source is unchanged')
        .option('--cpath <path>',  'path to the clang binary (overrides auto-detection)')
        .option('-g, --debug',     'compile with debug info (DWARF) for use with lldb/gdb debugger')
        .action((file: string, opts: { destination?: string; ir?: boolean; cache?: boolean; cpath?: string; debug?: boolean }) =>
            compileAction(file, { ...opts, noCache: opts.cache === false, debug: opts.debug })
        );

    program
        .command('run <file>')
        .description('Compile and immediately run a .code file')
        .option('-d, --destination <dir>', 'output directory for build artefacts')
        .option('--no-cache',      'force full rebuild even if source is unchanged')
        .option('--cpath <path>',  'path to the clang binary (overrides auto-detection)')
        .action((file: string, opts: { destination?: string; cache?: boolean; cpath?: string }) =>
            compileAction(file, { ...opts, run: true, noCache: opts.cache === false })
        );

    program
        .command('doc <file>')
        .description('Generate HTML documentation for a .code file')
        .option('--out <dir>', 'output directory (default: ./docs)')
        .action((file: string, opts: { out?: string }) =>
            docAction(file, opts)
        );

    program
        .command('build [step]')
        .description('Run a build.code build script (Zig-style)')
        .option('--script <file>',    'path to the build script (default: build.code)')
        .option('--optimize <mode>',  'optimize mode: Debug | ReleaseSafe | ReleaseFast | ReleaseSmall')
        .option('--prefix <dir>',     'installation prefix (default: build)')
        .option('--list',             'list all available steps and exit')
        .action((step: string | undefined, opts: { script?: string; optimize?: string; prefix?: string; list?: boolean }) =>
            buildAction(step, opts)
        );

    program.parse(process.argv);
}
