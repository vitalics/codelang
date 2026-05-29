import * as path from 'node:path';

/** Manages LLVM debug metadata (DWARF) for a single source file compilation. */
export class DebugInfo {
    private idx  = 5;   // 0–4 are reserved for module-level nodes
    private nodes = new Map<number, string>();
    private typeCache = new Map<string, number>();
    private locCache  = new Map<string, number>();

    readonly cuIdx   = 0;
    readonly fileIdx = 1;
    // 2 = Dwarf Version flag, 3 = Debug Info Version flag, 4 = wchar_size flag

    constructor(absSourcePath: string) {
        const filename  = path.basename(absSourcePath);
        const directory = path.dirname(absSourcePath);
        this.nodes.set(0, `distinct !DICompileUnit(language: DW_LANG_C99, file: !1, producer: "CodeLang 0.1.0", isOptimized: false, runtimeVersion: 0, emissionKind: FullDebug, splitDebugInlining: false)`);
        this.nodes.set(1, `!DIFile(filename: "${esc(filename)}", directory: "${esc(directory)}")`);
        this.nodes.set(2, `!{i32 7, !"Dwarf Version", i32 4}`);
        this.nodes.set(3, `!{i32 2, !"Debug Info Version", i32 3}`);
        this.nodes.set(4, `!{i32 1, !"wchar_size", i32 4}`);
    }

    private alloc(): number { return this.idx++; }

    /** Emit a DISubprogram for a function. Returns the metadata index for `!dbg !N` on `define`. */
    subprogram(name: string, line: number): number {
        const tyIdx = this.alloc();
        const spIdx = this.alloc();
        this.nodes.set(tyIdx, `!DISubroutineType(types: !{})`);
        this.nodes.set(spIdx, `distinct !DISubprogram(name: "${esc(name)}", scope: !1, file: !1, line: ${line}, type: !${tyIdx}, isLocal: false, isDefinition: true, scopeLine: ${line}, isOptimized: false, unit: !0, retainedNodes: !{})`);
        return spIdx;
    }

    /** Get-or-create a DILocation. Returns the metadata index. */
    location(line: number, col: number, scope: number): number {
        const key = `${line}:${col}:${scope}`;
        if (this.locCache.has(key)) return this.locCache.get(key)!;
        const idx = this.alloc();
        this.nodes.set(idx, `!DILocation(line: ${line}, column: ${col || 1}, scope: !${scope})`);
        this.locCache.set(key, idx);
        return idx;
    }

    /** Emit a DILocalVariable. Returns its metadata index (for dbg.declare). */
    localVar(name: string, line: number, scope: number, llvmType: string): number {
        const typeIdx = this.getOrEmitType(llvmType);
        const varIdx  = this.alloc();
        this.nodes.set(varIdx, `!DILocalVariable(name: "${esc(name)}", scope: !${scope}, file: !1, line: ${line}, type: !${typeIdx})`);
        return varIdx;
    }

    private getOrEmitType(llvmType: string): number {
        if (this.typeCache.has(llvmType)) return this.typeCache.get(llvmType)!;
        const idx = this.alloc();
        this.typeCache.set(llvmType, idx);
        let node: string;
        switch (llvmType) {
            case 'i1':     node = `!DIBasicType(name: "bool",   size: 8,  encoding: DW_ATE_boolean)`; break;
            case 'i8':     node = `!DIBasicType(name: "char",   size: 8,  encoding: DW_ATE_signed_char)`; break;
            case 'i16':    node = `!DIBasicType(name: "short",  size: 16, encoding: DW_ATE_signed)`; break;
            case 'i32':    node = `!DIBasicType(name: "int",    size: 32, encoding: DW_ATE_signed)`; break;
            case 'i64':    node = `!DIBasicType(name: "long",   size: 64, encoding: DW_ATE_signed)`; break;
            case 'u8':     node = `!DIBasicType(name: "uchar",  size: 8,  encoding: DW_ATE_unsigned_char)`; break;
            case 'u16':    node = `!DIBasicType(name: "ushort", size: 16, encoding: DW_ATE_unsigned)`; break;
            case 'u32':    node = `!DIBasicType(name: "uint",   size: 32, encoding: DW_ATE_unsigned)`; break;
            case 'u64':    node = `!DIBasicType(name: "ulong",  size: 64, encoding: DW_ATE_unsigned)`; break;
            case 'float':  node = `!DIBasicType(name: "float",  size: 32, encoding: DW_ATE_float)`; break;
            case 'double': node = `!DIBasicType(name: "double", size: 64, encoding: DW_ATE_float)`; break;
            case 'i8*': {
                // pointer-to-char → string
                const charIdx = this.getOrEmitType('i8');
                node = `!DIDerivedType(tag: DW_TAG_pointer_type, baseType: !${charIdx}, size: 64)`;
                break;
            }
            default:
                node = `!DIBasicType(name: "opaque", size: 64, encoding: DW_ATE_unsigned)`;
        }
        this.nodes.set(idx, node);
        return idx;
    }

    /** Append all debug metadata lines to the end of the module. */
    emit(): string[] {
        const out: string[] = [
            '',
            `!llvm.dbg.cu = !{!${this.cuIdx}}`,
            `!llvm.module.flags = !{!2, !3, !4}`,
            '',
        ];
        const maxIdx = Math.max(...this.nodes.keys());
        for (let i = 0; i <= maxIdx; i++) {
            const node = this.nodes.get(i);
            if (node !== undefined) out.push(`!${i} = ${node}`);
        }
        return out;
    }
}

function esc(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
