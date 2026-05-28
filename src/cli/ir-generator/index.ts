/**
 * LLVM IR text generator for CodeLang.
 *
 * Supported constructs:
 *   type X = intrinsic("llvm-ty")   ── stdlib type declarations (ignored at codegen)
 *   import { x } from "./mod"       ── module imports (resolved before codegen)
 *   export const fn / fn            ── function declarations with visibility
 *   let / const                     ── variable declarations  (alloca + store)
 *   x = expr                        ── assignment             (store)
 *   foo(args)                       ── function call          (call instruction)
 *   ns.foo(args)                    ── namespace call         (module import access)
 *   var.method()                    ── type method call       (inline IR intrinsic)
 *   print(expr)                     ── built-in print         (printf call)
 *   return expr                     ── return statement
 *   if cond { stmts } else { ... }  ── if statement           (conditional branch)
 *   if cond { expr } else { expr }  ── if expression          (phi-based value)
 *
 * Built-in type methods (lowered to inline LLVM IR, no function call overhead):
 *   bool  .toString()  →  i8*     "true" | "false"
 *         .toNumber()  →  i32     1 | 0
 *         .not()       →  i1      logical negation
 *   int   .toFloat()   →  double  signed integer → double
 *         .toBool()    →  i1      n != 0
 *   float .toInt()     →  i32     truncating cast
 *         .toBool()    →  i1      f != 0.0
 *
 * Multi-module compilation:
 *   The generator accepts a list of ResolvedModule objects (topological order,
 *   dependencies first).  All functions from all modules are emitted into a
 *   single LLVM IR compilation unit.
 *
 * Terminator tracking:
 *   emitStatement / emitStatements return true when the last instruction was a
 *   block terminator (ret, br, unreachable).  emitFunction uses this to avoid
 *   emitting a duplicate implicit return after an explicit one.
 */

import type {
    FunctionDeclaration,
    ExternDeclaration,
    Statement,
    VariableDeclaration,
    AssignmentStatement,
    CompoundAssignStatement,
    ForStatement,
    ForUpdate,
    PrintStatement,
    ReturnStatement,
    CallStatement,
    MemberCallStatement,
    MemberCallExpression,
    IfStatement,
    WhileStatement,
    IfExpression,
    Condition,
    BinaryCondition,
    Expression,
    StringLiteral,
    NumberLiteral,
    BoolLiteral,
    VariableRef,
    CallExpression,
    BinaryExpr,
    Parameter,
    TypeReference,
    TypeDeclaration,
    ExtensionDeclaration,
    ExtensionMethod,
    ExtensionProperty,
    TemplateLiteral,
    DeferStatement,
    UsingDeclaration,
    UnaryExpr,
    TypeParam,
    FieldAccess,
    FieldDeclaration,
    StructBody,
    StructMethod,
    ChainedMemberCallExpr,
    ChainedMemberCallStatement,
    StructLiteral,
    StructFieldInit,
    PanicStatement,
    ProtocolDeclaration,
    MethodSignature,
    LambdaExpression,
    BoolExprCondition,
    ArrayLiteral,
    SuperCallExpression,
    SelfCallExpression,
    AliasBody,
    CallableMethod,
    SwitchExpression,
    SwitchArm,
    SwitchStatement,
    SwitchStmtArm,
    // ── Enum types ──────────────────────────────────────────────────────────────
    EnumDeclaration,
    EnumVariant,
    EnumMethod,
    EnumConstructor,
    EnumPattern,
    // ── Macro types ─────────────────────────────────────────────────────────────
    MacroCallExpression,
    MacroCallStatement,
    // ── Postfix chaining ────────────────────────────────────────────────────────
    PostfixCallExpr,
} from '../../language/generated/ast.js';
import {
    isFunctionDeclaration,
    isExternDeclaration,
    isNamespaceImport,
    isVariableDeclaration,
    isAssignmentStatement,
    isCompoundAssignStatement,
    isForStatement,
    isPrintStatement,
    isPanicStatement,
    isReturnStatement,
    isCallStatement,
    isMemberCallStatement,
    isMemberCallExpression,
    isIfStatement,
    isWhileStatement,
    isIfExpression,
    isStringLiteral,
    isNumberLiteral,
    isBoolLiteral,
    isVariableRef,
    isCallExpression,
    isBinaryExpr,
    isIntrinsicBody,
    isAliasBody,
    isExtensionDeclaration,
    isSelfExpression,
    isTemplateLiteral,
    isDeferStatement,
    isUsingDeclaration,
    isUnaryExpr,
    isStructBody,
    isFieldDeclaration,
    isFieldAccess,
    isStructMethod,
    isChainedMemberCallExpr,
    isChainedMemberCallStatement,
    isStructLiteral,
    isAnonymousStructLiteral,
    AnonymousStructLiteral,
    isArrayLiteral,
    isProtocolDeclaration,
    isBinaryCondition,
    isBreakStatement,
    isContinueStatement,
    isLambdaExpression,
    isSuperCallExpression,
    isSuperCallStatement,
    isSelfCallExpression,
    isCallableMethod,
    isTypeDeclaration,
    isSwitchExpression,
    isSwitchStatement,
    // ── Enum type guards ────────────────────────────────────────────────────────
    isEnumDeclaration,
    isEnumVariant,
    isEnumMethod,
    isEnumConstructor,
    // ── Macro type guards ────────────────────────────────────────────────────────
    isMacroCallExpression,
    isMacroCallStatement,
    // ── Postfix chaining guard ───────────────────────────────────────────────────
    isPostfixCallExpr,
    // ── Conditional import ───────────────────────────────────────────────────────
    isSwitchImport,
    // ── Top-level macro calls ────────────────────────────────────────────────────
    isTopLevelMacroCall,
} from '../../language/generated/ast.js';
import * as nodePath from 'node:path';
import type { ResolvedModule } from '../module-resolver/index.js';
import { evalCompileCondition, resolveModulePath } from '../module-resolver/index.js';

// ── Number runtime ────────────────────────────────────────────────────────────

/** LLVM type used for the dynamic Number pointer. */
const NUMBER_TY = '%Number*';

/** True for the runtime-dynamic Number pointer type. */
function isNumberTy(ty: string): boolean { return ty === NUMBER_TY; }

// ── Function value (fat pointer) ─────────────────────────────────────────────

/**
 * LLVM type used for a first-class function value.
 * Layout: { fn_ptr: i8*, env_ptr: i8* }
 *   fn_ptr  — pointer to the concrete function (which takes the original params + i8* env)
 *   env_ptr — pointer to captured environment (null for non-capturing functions)
 */
const FNVAL_TY = '{ i8*, i8* }';

/** True for the fat-pointer function-value struct type. */
function isFnValTy(ty: string): boolean { return ty === FNVAL_TY; }

// ── Unsigned-integer helpers ──────────────────────────────────────────────────

/** All supported integer widths (shared by signed and unsigned checks). */
const INT_WIDTHS = new Set(['8', '16', '32', '64', '128', '256', '512']);

/**
 * True when `ty` is one of our unsigned-integer sentinel strings (u8 … u512).
 *
 * Unsigned types are stored as "u32", "u64", etc. in VarInfo and TypeDeclaration
 * intrinsic bodies.  These sentinels are NOT valid LLVM IR type names — always
 * call `toLLVM(ty)` before emitting any IR instruction.
 */
function isUnsignedTy(ty: string): boolean {
    return ty.length >= 2 && ty[0] === 'u' && INT_WIDTHS.has(ty.slice(1));
}

/**
 * True when `ty` is any integer sentinel — signed (i8 … i512) or unsigned
 * (u8 … u512).
 */
function isIntegerTy(ty: string): boolean {
    return ty.length >= 2 && (ty[0] === 'i' || ty[0] === 'u') && INT_WIDTHS.has(ty.slice(1));
}

/**
 * Translate a sentinel type to the corresponding LLVM IR type name.
 *
 *   u8  → i8    u16 → i16    u32 → i32
 *   u64 → i64   u128 → i128  u256 → i256   u512 → i512
 *   inf → double   negInf → double
 *
 * All other types (i32, double, i8*, %Number*, …) are returned unchanged.
 */
function toLLVM(ty: string): string {
    if (ty === 'inf' || ty === 'negInf') return 'double';
    return isUnsignedTy(ty) ? 'i' + ty.slice(1) : ty;
}

/**
 * True when `ty` resolves to a floating-point LLVM type (float or double).
 * Handles sentinels like "inf" / "negInf" which resolve to "double".
 */
function isFloatTy(ty: string): boolean {
    const r = toLLVM(ty);
    return r === 'double' || r === 'float';
}

/**
 * True when `ty` is an LLVM SIMD vector type: `<N x float>` or `<N x double>`.
 * These use float-family opcodes (fadd/fsub/fmul/fdiv) just like scalar floats,
 * but are NOT castable to/from integer types.
 *
 * Examples:  <2 x float>  <4 x float>  <8 x float>  <16 x float>
 *            <2 x double> <4 x double>
 */
function isSimdVectorTy(ty: string): boolean {
    return /^<\d+ x (float|double)>$/.test(ty);
}

/**
 * True for SIMD vector types wider than 128 bits.
 *
 * On ARM64 (Apple Silicon) the AAPCS64 ABI only supports NEON registers up to
 * 128 bits.  Passing <8 x float> (256-bit) or <16 x float> (512-bit) by value
 * across the LLVM IR → C function boundary causes a SIGBUS at runtime.
 *
 * Functions that take or return wide SIMD types must use pointer-based calling:
 *   - return <8 x float> → void, first param is float* (output buffer)
 *   - param  <8 x float> → float* (caller stores to alloca, passes pointer)
 *
 * <2 x float> (64 bits) and <4 x float> (128 bits = one NEON q register) are
 * fine for by-value passing.
 */
function isWideSimdTy(ty: string): boolean {
    const m = ty.match(/^<(\d+) x (float|double)>$/);
    if (!m) return false;
    const lanes       = parseInt(m[1], 10);
    const bitsPerLane = m[2] === 'double' ? 64 : 32;
    return lanes * bitsPerLane > 128;
}

/**
 * Convert a JS number to a valid LLVM IR floating-point constant string for
 * the given LLVM type.
 *
 * LLVM IR rules for decimal float constants:
 *   "The assembler requires the exact decimal value of a floating-point
 *    constant.  For example, the assembler accepts 1.25 but rejects 1.3
 *    because 1.3 is a repeating decimal in binary."
 *
 * Values like 0.4 or 0.1 are repeating binary fractions and are therefore
 * rejected by LLVM when written as decimals.  The workaround is to use the
 * 16-digit hex form that LLVM accepts for all float types:
 *
 *   float 0x3FD9999A00000000   ← 64-bit IEEE 754 double bits of 0.4f
 *
 * The hex representation uses the double-precision bit pattern of the
 * float32-rounded value, which is what LLVM expects for a `float` constant.
 */
function floatLitForType(raw: number, ty: string): string {
    // Integer values are always exact in any floating-point format.
    if (Number.isInteger(raw)) return `${raw}.0`;

    // For double / SIMD vectors — decimal representation is used as-is
    // (doubles are 64-bit so the JS string representation is already exact
    // enough for the default double-precision format).
    if (ty !== 'float') return String(raw);

    // float (32-bit): check whether the decimal is exactly representable.
    const f32      = Math.fround(raw);
    const f32str   = String(f32);     // JS canonical string for the float32 value
    const rawStr   = String(raw);
    if (f32str === rawStr) return rawStr; // exact (e.g. 0.5, 0.25, 2.0)

    // Non-exact: emit the 16-digit hex of the float32 value's double
    // representation (that is what LLVM IR requires for `float` constants).
    const buf  = new ArrayBuffer(8);
    new Float64Array(buf)[0] = f32;
    const view = new DataView(buf);
    // On little-endian hosts the Float64Array stores LSB first, so bytes 0-3
    // hold the low 32 bits and bytes 4-7 hold the high 32 bits.
    const lo = view.getUint32(0, true).toString(16).padStart(8, '0');
    const hi = view.getUint32(4, true).toString(16).padStart(8, '0');
    return `0x${hi.toUpperCase()}${lo.toUpperCase()}`;
}

/**
 * LLVM IR declarations required when any Number value is used.
 * %Number is an opaque struct; all operations go through C runtime calls.
 */
const NUMBER_DECLS = [
    '%Number = type opaque',
    '',
    'declare %Number* @number_from_int64(i64)',
    'declare %Number* @number_from_double(double)',
    'declare %Number* @number_add(%Number*, %Number*)',
    'declare %Number* @number_sub(%Number*, %Number*)',
    'declare %Number* @number_mul(%Number*, %Number*)',
    'declare %Number* @number_div(%Number*, %Number*)',
    'declare %Number* @number_mod(%Number*, %Number*)',
    'declare i32      @number_eq(%Number*, %Number*)',
    'declare i32      @number_ne(%Number*, %Number*)',
    'declare i32      @number_lt(%Number*, %Number*)',
    'declare i32      @number_le(%Number*, %Number*)',
    'declare i32      @number_gt(%Number*, %Number*)',
    'declare i32      @number_ge(%Number*, %Number*)',
    'declare void     @number_print(%Number*)',
    '; memoization helpers for pure const-param Number functions',
    'declare %Number* @number_memo_get1(i8**, %Number*)',
    'declare void     @number_memo_set1(i8**, %Number*, %Number*)',
].join('\n');

// ── Any runtime ───────────────────────────────────────────────────────────────

/** LLVM type used for the Any opaque pointer. */
const ANY_TY = '%Any*';

/** True for the heap-allocated Any pointer type. */

/**
 * The single LLVM IR forward-declaration needed when any Any value is used.
 * Any has no C runtime — its toString() is emitted inline by the IR generator.
 */
const ANY_DECL = '%Any = type opaque';

// ── Reflection runtime ────────────────────────────────────────────────────────
// Reserved for the forthcoming reflection feature; exported so the TypeScript
// compiler doesn't flag them as unused while the feature is in development.
export const FIELD_TY      = '%Field*';
// FieldArray has been replaced by PtrArray (Array<Field>); the constant is kept
// as a string literal alias so that any external code referencing FIELDARRAY_TY
// still compiles.  Value intentionally equals PTRARRAY_TY ('%PtrArray*').
export const FIELDARRAY_TY = '%PtrArray*';
export const TYPEINFO_TY   = '%TypeInfo*';

// FnInfo / ParamInfo — runtime snapshots of function and parameter declarations.
export const FNINFO_TY    = '%FnInfo*';
export const PARAMINFO_TY = '%ParamInfo*';

// ── Buffer runtime ────────────────────────────────────────────────────────────

/** LLVM type used for the Buffer pointer. */
const BUFFER_TY = '%Buffer*';

/** True for the heap-allocated Buffer pointer type. */
function isBufferTy(ty: string): boolean { return ty === BUFFER_TY; }

/**
 * The single LLVM IR forward-declaration needed when any Buffer value is used.
 * The four C runtime functions (string_to_buffer, buffer_length, buffer_get,
 * buffer_free) are declared via the normal ExternDeclaration path in
 * stdlib/buffer.code — no duplicates here.
 */
const BUFFER_DECLS = '%Buffer = type opaque';

// ── TuiBuffer (stdlib/tui.code) ───────────────────────────────────────────────
/** LLVM IR forward-declaration for the opaque TUI cell-buffer C struct. */
const TUIBUFFER_DECL = '%TuiBuffer = type opaque';

// ── IntArray runtime ──────────────────────────────────────────────────────────

/** LLVM type used for the IntArray pointer. */
const INTARRAY_TY = '%IntArray*';

/** True for the heap-allocated IntArray pointer type. */
function isIntArrayTy(ty: string): boolean { return ty === INTARRAY_TY; }

/**
 * The single LLVM IR forward-declaration needed when any IntArray value is used.
 * C runtime functions are declared via the normal ExternDeclaration path in
 * stdlib/array.code — no duplicates here.
 */
const INTARRAY_DECLS = '%IntArray = type opaque';

// ── StringArray runtime ───────────────────────────────────────────────────────

/** LLVM type used for the StringArray pointer. */
const STRINGARRAY_TY = '%StringArray*';

/** True for the heap-allocated StringArray pointer type. */
function isStringArrayTy(ty: string): boolean { return ty === STRINGARRAY_TY; }

/**
 * The single LLVM IR forward-declaration needed when any StringArray value is used.
 */
const STRINGARRAY_DECLS = '%StringArray = type opaque';

// ── PtrArray runtime (generic struct-element array) ──────────────────────────

/** LLVM type used for the shared void*-backed PtrArray. */
const PTRARRAY_TY = '%PtrArray*';

/** True for the heap-allocated PtrArray pointer type. */
function isPtrArrayTy(ty: string): boolean { return ty === PTRARRAY_TY; }

/** The single LLVM IR forward-declaration needed when any PtrArray value is used. */
const PTRARRAY_DECLS = '%PtrArray = type opaque';


// ── NumberArray runtime ───────────────────────────────────────────────────────

/** LLVM type used for the NumberArray pointer. */
const NUMBERARRAY_TY = '%NumberArray*';

/** True for the heap-allocated NumberArray pointer type. */
function isNumberArrayTy(ty: string): boolean { return ty === NUMBERARRAY_TY; }

/** The single LLVM IR forward-declaration needed when any NumberArray value is used. */
const NUMBERARRAY_DECLS = '%NumberArray = type opaque';

// ── AnyArray runtime ──────────────────────────────────────────────────────────

/** LLVM type used for the AnyArray pointer. */
const ANYARRAY_TY = '%AnyArray*';

/** True for the heap-allocated AnyArray pointer type. */
function isAnyArrayTy(ty: string): boolean { return ty === ANYARRAY_TY; }

/** The single LLVM IR forward-declaration needed when any AnyArray value is used. */
const ANYARRAY_DECLS = '%AnyArray = type opaque';

// ── BoolArray runtime ─────────────────────────────────────────────────────────

/** LLVM type used for the BoolArray pointer. */
const BOOLARRAY_TY = '%BoolArray*';

/** True for the heap-allocated BoolArray pointer type. */
function isBoolArrayTy(ty: string): boolean { return ty === BOOLARRAY_TY; }

/** The single LLVM IR forward-declaration needed when any BoolArray value is used. */
const BOOLARRAY_DECLS = '%BoolArray = type opaque';

// ── FloatArray runtime ────────────────────────────────────────────────────────

/** LLVM type used for the FloatArray pointer (f32 elements). */
const FLOATARRAY_TY = '%FloatArray*';

/** True for the heap-allocated FloatArray pointer type. */
function isFloatArrayTy(ty: string): boolean { return ty === FLOATARRAY_TY; }

/** The single LLVM IR forward-declaration needed when any FloatArray value is used. */
const FLOATARRAY_DECLS = '%FloatArray = type opaque';

// ── DoubleArray runtime ───────────────────────────────────────────────────────

/** LLVM type used for the DoubleArray pointer (f64 elements). */
const DOUBLEARRAY_TY = '%DoubleArray*';

/** True for the heap-allocated DoubleArray pointer type. */
function isDoubleArrayTy(ty: string): boolean { return ty === DOUBLEARRAY_TY; }

/** The single LLVM IR forward-declaration needed when any DoubleArray value is used. */
const DOUBLEARRAY_DECLS = '%DoubleArray = type opaque';

// ── IntSet runtime ────────────────────────────────────────────────────────────

/** LLVM type used for the IntSet pointer. */
const INTSET_TY = '%IntSet*';

/** True for the heap-allocated IntSet pointer type. */
function isIntSetTy(ty: string): boolean { return ty === INTSET_TY; }

/** The single LLVM IR forward-declaration needed when any IntSet value is used. */
const INTSET_DECLS = '%IntSet = type opaque';

// ── StringSet runtime ─────────────────────────────────────────────────────────

/** LLVM type used for the StringSet pointer. */
const STRINGSET_TY = '%StringSet*';

/** True for the heap-allocated StringSet pointer type. */
function isStringSetTy(ty: string): boolean { return ty === STRINGSET_TY; }

/** The single LLVM IR forward-declaration needed when any StringSet value is used. */
const STRINGSET_DECLS = '%StringSet = type opaque';

// ── BoolSet runtime ───────────────────────────────────────────────────────────

/** LLVM type used for the BoolSet pointer. */
const BOOLSET_TY = '%BoolSet*';

/** True for the heap-allocated BoolSet pointer type. */
function isBoolSetTy(ty: string): boolean { return ty === BOOLSET_TY; }

/** The single LLVM IR forward-declaration needed when any BoolSet value is used. */
const BOOLSET_DECLS = '%BoolSet = type opaque';

// ── FloatSet runtime ──────────────────────────────────────────────────────────

/** LLVM type used for the FloatSet pointer (f32 elements). */
const FLOATSET_TY = '%FloatSet*';

/** True for the heap-allocated FloatSet pointer type. */
function isFloatSetTy(ty: string): boolean { return ty === FLOATSET_TY; }

/** The single LLVM IR forward-declaration needed when any FloatSet value is used. */
const FLOATSET_DECLS = '%FloatSet = type opaque';

// ── DoubleSet runtime ─────────────────────────────────────────────────────────

/** LLVM type used for the DoubleSet pointer (f64 elements). */
const DOUBLESET_TY = '%DoubleSet*';

/** True for the heap-allocated DoubleSet pointer type. */
function isDoubleSetTy(ty: string): boolean { return ty === DOUBLESET_TY; }

/** The single LLVM IR forward-declaration needed when any DoubleSet value is used. */
const DOUBLESET_DECLS = '%DoubleSet = type opaque';

// ── NumberSet runtime ─────────────────────────────────────────────────────────

/** LLVM type used for the NumberSet pointer (%Number* elements). */
const NUMBERSET_TY = '%NumberSet*';

/** True for the heap-allocated NumberSet pointer type. */
function isNumberSetTy(ty: string): boolean { return ty === NUMBERSET_TY; }

/** The single LLVM IR forward-declaration needed when any NumberSet value is used. */
const NUMBERSET_DECLS = '%NumberSet = type opaque';

// ── IntIntMap runtime ─────────────────────────────────────────────────────────

const INTINTMAP_TY = '%IntIntMap*';
function isIntIntMapTy(ty: string): boolean { return ty === INTINTMAP_TY; }
const INTINTMAP_DECLS = '%IntIntMap = type opaque';

// ── IntStringMap runtime ──────────────────────────────────────────────────────

const INTSTRINGMAP_TY = '%IntStringMap*';
function isIntStringMapTy(ty: string): boolean { return ty === INTSTRINGMAP_TY; }
const INTSTRINGMAP_DECLS = '%IntStringMap = type opaque';

// ── StringIntMap runtime ──────────────────────────────────────────────────────

const STRINGINTMAP_TY = '%StringIntMap*';
function isStringIntMapTy(ty: string): boolean { return ty === STRINGINTMAP_TY; }
const STRINGINTMAP_DECLS = '%StringIntMap = type opaque';

// ── StringStringMap runtime ───────────────────────────────────────────────────

const STRINGSTRINGMAP_TY = '%StringStringMap*';
function isStringStringMapTy(ty: string): boolean { return ty === STRINGSTRINGMAP_TY; }
const STRINGSTRINGMAP_DECLS = '%StringStringMap = type opaque';

// ── IntPtrMap runtime ─────────────────────────────────────────────────────────

const INTPTRMAP_TY = '%IntPtrMap*';
function isIntPtrMapTy(ty: string): boolean { return ty === INTPTRMAP_TY; }
const INTPTRMAP_DECLS = '%IntPtrMap = type opaque';

// ── StringPtrMap runtime ──────────────────────────────────────────────────────

const STRINGPTRMAP_TY = '%StringPtrMap*';
function isStringPtrMapTy(ty: string): boolean { return ty === STRINGPTRMAP_TY; }
const STRINGPTRMAP_DECLS = '%StringPtrMap = type opaque';

// ── PtrIntMap runtime ─────────────────────────────────────────────────────────

const PTRINTMAP_TY = '%PtrIntMap*';
function isPtrIntMapTy(ty: string): boolean { return ty === PTRINTMAP_TY; }
const PTRINTMAP_DECLS = '%PtrIntMap = type opaque';

// ── PtrStringMap runtime ──────────────────────────────────────────────────────

const PTRSTRMAP_TY = '%PtrStringMap*';
function isPtrStrMapTy(ty: string): boolean { return ty === PTRSTRMAP_TY; }
const PTRSTRMAP_DECLS = '%PtrStringMap = type opaque';

// ── PtrPtrMap runtime ─────────────────────────────────────────────────────────

const PTRPTRMAP_TY = '%PtrPtrMap*';
function isPtrPtrMapTy(ty: string): boolean { return ty === PTRPTRMAP_TY; }
const PTRPTRMAP_DECLS = '%PtrPtrMap = type opaque';

/** True when `ty` is any of the five Ptr-keyed or Ptr-valued map types. */
function isAnyPtrMapTy(ty: string): boolean {
    return ty === INTPTRMAP_TY || ty === STRINGPTRMAP_TY
        || ty === PTRINTMAP_TY || ty === PTRSTRMAP_TY || ty === PTRPTRMAP_TY;
}

// ── Matrix runtime (NPU / Accelerate) ────────────────────────────────────────

/** LLVM type used for the opaque Matrix pointer (runtime/npu.c). */
const MATRIX_TY = '%Matrix*';

/** True for the heap-allocated Matrix pointer type (stdlib/npu.code). */
function isMatrixTy(ty: string): boolean { return ty === MATRIX_TY; }

/** The single LLVM IR forward-declaration needed when any Matrix value is used. */
const MATRIX_DECLS = '%Matrix = type opaque';

// ── Core ML runtime (stdlib/npu/apple_coreml.code) ───────────────────────────

const COREML_MODEL_TY     = '%CoreMLModel*';
const QUANTIZED_MATRIX_TY = '%QuantizedMatrix*';

/** True for either of the two opaque CoreML pointer types. */
function isCoreMLTy(ty: string): boolean {
    return ty === COREML_MODEL_TY || ty === QUANTIZED_MATRIX_TY;
}

// ── Async runtime (stdlib/async.code) ────────────────────────────────────────

const TASK_TY      = '%Task*';
const CONTEXT_TY   = '%AsyncContext*';
const SHARED_TY    = '%Shared*';
const SCHEDULER_TY = '%Scheduler*';
const ASYNC_TY     = '%Async*';

function isAsyncTy(ty: string): boolean {
    return ty === TASK_TY || ty === CONTEXT_TY || ty === SHARED_TY ||
           ty === SCHEDULER_TY || ty === ASYNC_TY;
}

const ASYNC_DECLS = [
    '%Task = type opaque',
    '%AsyncContext = type opaque',
    '%Shared = type opaque',
    '%Scheduler = type opaque',
    '%Async = type opaque',
].join('\n');

/**
 * Resolve a two-parameter Map<K,V> generic to the concrete LLVM map type.
 *
 *   Map<int,    int>    → %IntIntMap*
 *   Map<int,    string> → %IntStringMap*
 *   Map<string, int>    → %StringIntMap*
 *   Map<string, string> → %StringStringMap*
 *   Map<int,    T>      → %IntPtrMap*      (T = user struct)
 *   Map<string, T>      → %StringPtrMap*   (T = user struct)
 *   Map<T,      int>    → %PtrIntMap*      (T = user struct, key by identity)
 *   Map<T,      string> → %PtrStringMap*   (T = user struct, key by identity)
 *   Map<T,      V>      → %PtrPtrMap*      (both = user structs, key by identity)
 */
function dynamicMapLLVMType(keyIRType: string, valIRType: string): string {
    if (keyIRType === 'i32' && valIRType === 'i32')  return INTINTMAP_TY;
    if (keyIRType === 'i32' && valIRType === 'i8*')  return INTSTRINGMAP_TY;
    if (keyIRType === 'i8*' && valIRType === 'i32')  return STRINGINTMAP_TY;
    if (keyIRType === 'i8*' && valIRType === 'i8*')  return STRINGSTRINGMAP_TY;
    if (keyIRType === 'i32' && isStructPtrTy(valIRType)) return INTPTRMAP_TY;
    if (keyIRType === 'i8*' && isStructPtrTy(valIRType)) return STRINGPTRMAP_TY;
    if (isStructPtrTy(keyIRType) && valIRType === 'i32') return PTRINTMAP_TY;
    if (isStructPtrTy(keyIRType) && valIRType === 'i8*') return PTRSTRMAP_TY;
    if (isStructPtrTy(keyIRType) && isStructPtrTy(valIRType)) return PTRPTRMAP_TY;
    return STRINGSTRINGMAP_TY;  // fallback
}

/** True when `ty` is any of the nine concrete map types. */
function isAnyMapTy(ty: string): boolean {
    return ty === INTINTMAP_TY || ty === INTSTRINGMAP_TY
        || ty === STRINGINTMAP_TY || ty === STRINGSTRINGMAP_TY
        || ty === INTPTRMAP_TY || ty === STRINGPTRMAP_TY
        || ty === PTRINTMAP_TY || ty === PTRSTRMAP_TY || ty === PTRPTRMAP_TY;
}

/**
 * Maps a resolved LLVM element type to the corresponding stdlib set LLVM pointer type.
 * Used for the `Set<T>` generic alias resolution.
 *
 *   int    → i32      → %IntSet*
 *   string → i8*      → %StringSet*
 *   bool   → i1       → %BoolSet*
 *   float  → float    → %FloatSet*
 *   double → double   → %DoubleSet*
 *   Number → %Number* → %NumberSet*
 */
function dynamicSetLLVMType(elemIRType: string): string {
    switch (elemIRType) {
        case 'i32':      return INTSET_TY;
        case 'i8*':      return STRINGSET_TY;
        case 'i1':       return BOOLSET_TY;
        case 'float':    return FLOATSET_TY;
        case 'double':   return DOUBLESET_TY;
        case '%Number*': return NUMBERSET_TY;
        default:         return INTSET_TY;  // fallback
    }
}

/**
 * Strips the leading `%` and trailing `*` from an opaque pointer LLVM type
 * to produce the bare type name used as a static-dispatch receiver.
 *
 *   '%IntIntMap*'  → 'IntIntMap'
 *   '%IntSet*'     → 'IntSet'
 *   '%IntArray*'   → 'IntArray'
 */
function llvmPtrTypeToName(ty: string): string {
    if (ty.startsWith('%') && ty.endsWith('*')) return ty.slice(1, -1);
    return ty;
}

/**
 * Resolve a generic collection alias (`Map`, `Set`, `Array`) with explicit
 * type arguments to the corresponding concrete LLVM pointer type.
 *
 *   resolveGenericAlias('Map',   [int, int])  → '%IntIntMap*'
 *   resolveGenericAlias('Set',   [string])    → '%StringSet*'
 *   resolveGenericAlias('Array', [int])       → '%IntArray*'
 *
 * Returns `null` when the alias or arity is not recognised.
 */
function resolveGenericAlias(alias: string, nsTypeArgs: TypeReference[]): string | null {
    if (alias === 'Map' && nsTypeArgs.length === 2) {
        const keyLLVM = toLLVM(resolveTypeRef(nsTypeArgs[0]));
        const valLLVM = toLLVM(resolveTypeRef(nsTypeArgs[1]));
        return dynamicMapLLVMType(keyLLVM, valLLVM);
    }
    if (alias === 'Set' && nsTypeArgs.length === 1) {
        const elemLLVM = toLLVM(resolveTypeRef(nsTypeArgs[0]));
        return dynamicSetLLVMType(elemLLVM);
    }
    if (alias === 'Array' && nsTypeArgs.length === 1) {
        const elemLLVM = toLLVM(resolveTypeRef(nsTypeArgs[0]));
        return dynamicArrayLLVMType(elemLLVM);
    }
    return null;
}

/** Generic collection alias names whose static methods can be resolved via type info. */
const GENERIC_COLLECTION_ALIASES = new Set(['Map', 'Set', 'Array']);

/** Push function info for each dynamic array type. Used by `emitArrayLiteral`. */
const ARRAY_PUSH_INFO: Record<string, { elemIRTy: string; pushFn: string }> = {
    '%IntArray*':    { elemIRTy: 'i32',      pushFn: 'intarray_push'    },
    '%StringArray*': { elemIRTy: 'i8*',      pushFn: 'stringarray_push' },
    '%BoolArray*':   { elemIRTy: 'i1',       pushFn: 'boolarray_push'   },
    '%NumberArray*': { elemIRTy: '%Number*', pushFn: 'numberarray_push' },
    '%FloatArray*':  { elemIRTy: 'float',    pushFn: 'floatarray_push'  },
    '%DoubleArray*': { elemIRTy: 'double',   pushFn: 'doublearray_push' },
    '%AnyArray*':    { elemIRTy: 'i8*',      pushFn: 'anyarray_push'    },
    '%PtrArray*':    { elemIRTy: 'i8*',      pushFn: 'ptrarray_push'    },
};

/**
 * True when `ty` is a pointer to a user-defined struct (e.g. `%User*`, `%Point*`),
 * as opposed to a known runtime or array type.
 * Used for pointer bitcast coercion in PtrArray push/get operations.
 */
function isStructPtrTy(ty: string): boolean {
    if (!ty.startsWith('%') || !ty.endsWith('*')) return false;
    // Exclude all known runtime / array / set types
    const KNOWN_RUNTIME_TYPES = new Set([
        '%IntArray*', '%StringArray*', '%BoolArray*', '%NumberArray*',
        '%AnyArray*', '%PtrArray*', '%FloatArray*', '%DoubleArray*',
        '%Number*', '%Any*', '%Buffer*',
        // Note: %Field*, %PropertyField*, %FunctionField* are NOT excluded here so that
        // `const f: Field = array.get(i)` triggers the automatic i8* → %Field* bitcast.
        '%FieldArray*', '%TypeInfo*',
        '%FnInfo*', '%ParamInfo*',
        '%IntSet*', '%StringSet*', '%BoolSet*',
        '%FloatSet*', '%DoubleSet*', '%NumberSet*',
    ]);
    if (KNOWN_RUNTIME_TYPES.has(ty)) return false;
    if (isAnyMapTy(ty)) return false;
    return true;
}

/**
 * Returns the byte size of a SIMD vector LLVM type such as `<4 x float>`.
 * Used when boxing SIMD values into heap memory for PtrArray storage.
 */
function simdByteSize(ty: string): number {
    const m = ty.match(/^<(\d+) x (float|double|i\d+)>$/);
    if (!m) return 16;
    const n = parseInt(m[1]);
    const w = m[2] === 'double' ? 8 : m[2] === 'float' ? 4 : Math.ceil(parseInt(m[2].slice(1)) / 8);
    return n * w;
}

/**
 * Maps a resolved LLVM element type to the corresponding stdlib dynamic-array
 * LLVM pointer type.  Used for the `ElemType[]` array-shorthand syntax and
 * the `Array<T>` generic alias.
 *
 *   int    → i32      → %IntArray*
 *   string → i8*      → %StringArray*
 *   bool   → i1       → %BoolArray*
 *   Number → %Number* → %NumberArray*
 *   Any    → %Any*    → %AnyArray*
 *   Float  → float    → %FloatArray*
 *   float  → double   → %DoubleArray*
 *   Float2 → <2xfloat>→ %PtrArray* (boxed SIMD)
 */
function dynamicArrayLLVMType(elemIRType: string): string {
    switch (elemIRType) {
        case 'i32':       return INTARRAY_TY;
        case 'i8*':       return STRINGARRAY_TY;
        case 'i1':        return BOOLARRAY_TY;
        case '%Number*':  return NUMBERARRAY_TY;
        case '%Any*':     return ANYARRAY_TY;
        case 'float':     return FLOATARRAY_TY;
        case 'double':    return DOUBLEARRAY_TY;
        default:
            // Any named struct pointer (e.g., %User*) → shared PtrArray backing.
            if (elemIRType.startsWith('%') && elemIRType.endsWith('*')) {
                return PTRARRAY_TY;
            }
            // SIMD vector types (<N x float>, <N x double>) → boxed PtrArray.
            if (elemIRType.startsWith('<') && elemIRType.endsWith('>')) {
                return PTRARRAY_TY;
            }
            return `%${elemIRType.replace(/\*/g, 'Ptr').replace(/%/g, '')}Array*`;
    }
}

const NUMBER_CMP_FN: Record<string, string> = {
    '==': 'number_eq',
    '!=': 'number_ne',
    '<':  'number_lt',
    '<=': 'number_le',
    '>':  'number_gt',
    '>=': 'number_ge',
};

const NUMBER_ARITH_FN: Record<string, string> = {
    '+': 'number_add',
    '-': 'number_sub',
    '*': 'number_mul',
    '/': 'number_div',
    '%': 'number_mod',
};

// ── Generics helpers ──────────────────────────────────────────────────────────

/** Map from type parameter name → concrete LLVM type string during monomorphization. */
type TypeEnv = ReadonlyMap<string, string>;
const EMPTY_ENV: TypeEnv = new Map<string, string>();

/**
 * A safe identifier suffix for an LLVM type — usable in function/struct names.
 * Examples: 'i32' → 'i32', 'i8*' → 'str', '%Foo*' → 'Foo', 'double' → 'f64'
 */
function llvmTypeToSuffix(ty: string): string {
    const TABLE: Record<string, string> = {
        'i1': 'bool', 'i8': 'i8', 'i16': 'i16', 'i32': 'i32', 'i64': 'i64',
        'u8': 'u8', 'u16': 'u16', 'u32': 'u32', 'u64': 'u64',
        'float': 'f32', 'double': 'f64', 'i8*': 'str', 'void': 'void',
    };
    if (TABLE[ty]) return TABLE[ty];
    const m = ty.match(/^%(.+)\*$/);
    if (m) return m[1];  // %Foo* → Foo
    return ty.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Maps an LLVM type string to a human-readable CodeLang type name.
 * Used by the reflection intrinsic (`typeInfo<T>`) to populate `TypeInfo.name`.
 *
 *   i1       → "bool"
 *   i32      → "int"
 *   i8*      → "string"
 *   %Foo*    → "Foo"   (struct / opaque type)
 */
function llvmTypeToReadableName(ty: string): string {
    const TABLE: Record<string, string> = {
        'i1': 'bool', 'i8': 'i8', 'i16': 'i16', 'i32': 'int', 'i64': 'i64',
        'u8': 'u8', 'u16': 'u16', 'u32': 'u32', 'u64': 'u64',
        'float': 'float', 'double': 'double', 'i8*': 'string', 'void': 'void',
    };
    if (TABLE[ty]) return TABLE[ty];
    const m = ty.match(/^%(.+)\*$/);
    if (m) return m[1];  // %Foo* → "Foo"
    return ty.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Mangle a generic type instantiation to a concrete LLVM type name.
 * baseName: the llvmType string from IntrinsicBody (e.g. "%Array" without * or suffix)
 * typeArgs: the concrete TypeReference arguments
 * env: current TypeEnv for resolving nested type params
 */
function mangleGenericType(baseName: string, typeArgs: TypeReference[], env: TypeEnv): string {
    const base = baseName.replace(/^%/, '').replace(/\*$/, '');
    const suffixes = typeArgs.map(a => llvmTypeToSuffix(resolveTypeRefWithEnv(a, env)));
    return `%${base}_${suffixes.join('_')}*`;
}

/** Whether an LLVM type string looks like a mangled generic (e.g. %Array_i32*). */
function isGenericMangledTy(ty: string): boolean {
    return /^%[A-Za-z_][A-Za-z0-9_]*_[A-Za-z0-9_]+\*$/.test(ty);
}

// ── Tuple-type encoding ───────────────────────────────────────────────────────
//
// Tuple types are represented as "tuple:T1;T2;..." strings inside TypeEnv.
// They are NOT valid LLVM types; the compiler only uses them to expand
// spread fn params (fn(...A): R) and to infer fn-val signatures.

const TUPLE_PREFIX = 'tuple:';
/** Encode a list of LLVM types as a tuple encoding string. */
function encodeTuple(types: string[]): string { return TUPLE_PREFIX + types.join(';'); }
/** Whether a type-env value encodes a tuple. */
function isTupleEnc(ty: string): boolean { return ty.startsWith(TUPLE_PREFIX); }
/** Decode a tuple encoding into its element LLVM types. */
function decodeTuple(ty: string): string[] {
    if (!isTupleEnc(ty)) return [ty];
    const inner = ty.slice(TUPLE_PREFIX.length);
    return inner === '' ? [] : inner.split(';');
}

/**
 * Resolve a TypeReference to an LLVM type string, with optional TypeEnv for
 * substituting type parameters.
 *
 * If the cross-reference fails to resolve (because the ID refers to a TypeParam
 * rather than a TypeDeclaration), we fall back to the raw reference text and
 * look it up in `env`.
 */
/**
 * Returns true if this TypeReference carries the `const` qualifier
 * (written as `const Type` in CodeLang source).
 *
 * `const` on a type pins the representation — the value will never be
 * automatically promoted to a wider or heap-allocated form at runtime.
 * The only type where this matters at the LLVM level is `Number` (%Number*)
 * which normally auto-upgrades to BigInt on overflow; `const Number` keeps
 * the value as a fixed-width i64 instead.
 */
function isConstQualifiedTypeRef(typeRef: TypeReference): boolean {
    return (typeRef as any).constQualified === true;
}

function resolveTypeRefWithEnv(typeRef: TypeReference | undefined, env: TypeEnv): string {
    if (!typeRef) return 'void';
    if (typeRef.primitive === 'void') return 'void';

    // ── `Self` keyword in type position ──────────────────────────────────────
    // Used in protocol static method return types: `static fn new(...): Self`
    // Resolved via a 'Self' entry injected into the env by the calling emitter.
    if ((typeRef as any).selfType) {
        return env.get('Self') ?? 'i8*';
    }

    // ── const-qualified named type ────────────────────────────────────────────
    // `const T` pins the representation — the value won't be auto-promoted.
    // For most types, `const T` has the same LLVM representation as `T`.
    // Exception: `const Number` prevents the %Number* heap allocation and is
    // represented as i64 (a fixed-width 64-bit integer) instead.
    if (isConstQualifiedTypeRef(typeRef)) {
        // Resolve without the const flag first to get the base LLVM type.
        const baseType = resolveTypeRefWithEnv({ ...typeRef, constQualified: false } as TypeReference, env);
        // %Number* → i64 (no BigInt auto-scaling)
        if (baseType === '%Number*') return 'i64';
        // Everything else: same representation, constraint is type-system only.
        return baseType;
    }

    // ── Tuple type: [T1, T2, ...] → tuple encoding (not a real LLVM type) ────
    if ((typeRef as any).tupleType) {
        const elems: TypeReference[] = (typeRef as any).tupleElems ?? [];
        return encodeTuple(elems.map(e => resolveTypeRefWithEnv(e, env)));
    }

    // ── Function type: fn(T1, T2): R or fn(...A): R → fat pointer { i8*, i8* }
    if ((typeRef as any).fnType) return FNVAL_TY;

    // ── Array type shorthand: ElemType[N] or ElemType[] ──────────────────────
    const elemDecl = typeRef.elemRef?.ref;
    if (elemDecl) {
        const elemTy = isEnumDeclaration(elemDecl)
            ? resolveEnumDeclWithArgs(elemDecl, [], env)
            : resolveTypeDeclWithArgs(elemDecl, [], env); // e.g. "i32" for int
        if (typeRef.arraySize !== undefined) {
            // Fixed-size embedded array: [N x T]
            return `[${typeRef.arraySize} x ${toLLVM(elemTy)}]`;
        } else {
            // Dynamic array sugar: map the resolved LLVM element type to its stdlib array name.
            // e.g. int (→ i32) → %IntArray*, string (→ i8*) → %StringArray*
            return dynamicArrayLLVMType(toLLVM(elemTy));
        }
    }
    // Unresolved elemRef — treat as a type parameter name (rare fallback)
    const elemRefText = (typeRef.elemRef as any)?.$refText as string | undefined;
    if (elemRefText) {
        if (typeRef.arraySize !== undefined) {
            const elemIR = env.get(elemRefText) ?? 'i8*';
            return `[${typeRef.arraySize} x ${toLLVM(elemIR)}]`;
        }
        return dynamicArrayLLVMType(env.get(elemRefText) ?? 'i8*');
    }

    const decl = typeRef.ref?.ref;
    if (decl) {
        if (isEnumDeclaration(decl)) {
            return resolveEnumDeclWithArgs(decl, typeRef.typeArgs ?? [], env);
        }
        return resolveTypeDeclWithArgs(decl, typeRef.typeArgs ?? [], env);
    }
    // Unresolved cross-reference — treat as a type parameter name or `Self`
    const paramName = (typeRef.ref as any)?.$refText as string | undefined;
    if (paramName && env.has(paramName)) return env.get(paramName)!;
    // `Self` in a protocol method signature — resolved via the 'Self' env entry
    // (injected by emitProtocolDefaultStaticMethod via resolveTypeRefWithEnv with a Self-env)
    if (paramName === 'Self' && env.has('Self')) return env.get('Self')!;
    return 'i8*';
}

/**
 * Resolve a TypeDeclaration, optionally with concrete type arguments (for generic types).
 * Builds a new TypeEnv from the declaration's typeParams + the provided typeArgs,
 * then resolves the body in that env.
 */

/**
 * Resolve the default type for a TypeParam, if one is declared.
 * Returns undefined when the parameter has no default.
 *
 * E.g. `N extends Int = Int` → resolves `Int` (the default) to its LLVM type.
 */
function resolveTypeParamDefault(param: TypeParam, env: TypeEnv): string | undefined {
    const defaultType = param.defaultType as TypeReference | undefined;
    if (defaultType) return resolveTypeRefWithEnv(defaultType, env);
    return undefined;
}

function resolveTypeDeclWithArgs(decl: TypeDeclaration, typeArgs: TypeReference[], env: TypeEnv): string {
    const body = decl.body;
    const params: TypeParam[] = (decl as any).typeParams ?? [];

    if (isIntrinsicBody(body)) {
        if (params.length > 0 && typeArgs.length > 0) {
            // Special case: Array<T> / Array<T, N> → concrete stdlib array type.
            // The second type param N (the integer index type, e.g. Int/Int32) is
            // used for Countable<N> conformance; the LLVM representation depends
            // only on T (the element type).
            if (decl.name === 'Array' && typeArgs.length >= 1) {
                const elemLLVM = toLLVM(resolveTypeRefWithEnv(typeArgs[0], env));
                return dynamicArrayLLVMType(elemLLVM);
            }
            // Special case: Set<T> → concrete stdlib set type via dynamicSetLLVMType
            if (decl.name === 'Set' && typeArgs.length === 1) {
                const elemLLVM = toLLVM(resolveTypeRefWithEnv(typeArgs[0], env));
                return dynamicSetLLVMType(elemLLVM);
            }
            // Special case: Map<K,V> → concrete map type via dynamicMapLLVMType
            if (decl.name === 'Map' && typeArgs.length === 2) {
                const keyLLVM = toLLVM(resolveTypeRefWithEnv(typeArgs[0], env));
                const valLLVM = toLLVM(resolveTypeRefWithEnv(typeArgs[1], env));
                return dynamicMapLLVMType(keyLLVM, valLLVM);
            }
            // Generic intrinsic: mangle name using the resolved type args
            return mangleGenericType(body.llvmType, typeArgs, env);
        }
        return body.llvmType;
    }
    if (isAliasBody(body)) {
        // body.alias is now a TypeReference (after grammar change)
        const aliasRef = body.alias as TypeReference | undefined;
        if (aliasRef) {
            // Build inner env: map this decl's typeParams → resolved typeArgs,
            // falling back to the param's defaultType when no explicit arg is given.
            if (params.length > 0) {
                const innerEnv = new Map(env);
                params.forEach((p, i) => {
                    if (typeArgs[i]) {
                        innerEnv.set(p.name, resolveTypeRefWithEnv(typeArgs[i], env));
                    } else {
                        const def = resolveTypeParamDefault(p, env);
                        if (def !== undefined) innerEnv.set(p.name, def);
                    }
                });
                return resolveTypeRefWithEnv(aliasRef, innerEnv);
            }
            return resolveTypeRefWithEnv(aliasRef, env);
        }
    }
    if (isStructBody(body)) {
        // Struct types are heap-allocated; the CodeLang type is a pointer to the LLVM struct.
        return `%${decl.name}*`;
    }
    return 'i8*';
}

// ── Enum type resolver ────────────────────────────────────────────────────────

/**
 * Resolve an EnumDeclaration to its LLVM type string.
 *
 * All enums (unit-only or tagged union) are represented as heap pointers
 * to their base struct type so that method dispatch works uniformly.
 *
 *   Direction  →  %Direction*
 *   Option<int> →  %Option_i32*
 */
function resolveEnumDeclWithArgs(decl: EnumDeclaration, typeArgs: TypeReference[], env: TypeEnv): string {
    const params: TypeParam[] = (decl as any).typeParams ?? [];
    // Resolve each param: explicit typeArg > defaultType > 'i8*'
    const resolvedArgs: string[] = params.map((p, i) => {
        if (typeArgs[i]) return resolveTypeRefWithEnv(typeArgs[i], env);
        const def = resolveTypeParamDefault(p, env);
        return def ?? 'i8*';
    });
    const hasAnyArg = params.length > 0 && (typeArgs.length > 0 || resolvedArgs.some((_, i) => !!params[i].defaultType));
    const baseName = hasAnyArg
        ? `${decl.name}_${resolvedArgs.map(argTy =>
            toLLVM(argTy).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
          ).join('_')}`
        : decl.name;
    return `%${baseName}*`;
}

// ── LLVM type helpers ─────────────────────────────────────────────────────────

// ── Backward-compat wrappers (used everywhere in the existing code) ────────────

function resolveTypeRef(typeRef: TypeReference | undefined): string {
    return resolveTypeRefWithEnv(typeRef, EMPTY_ENV);
}

/** Resolve any named type (struct TypeDeclaration or EnumDeclaration) to an LLVM type string. */
function resolveNamedType(decl: TypeDeclaration | EnumDeclaration): string {
    if (isEnumDeclaration(decl)) return resolveEnumDeclWithArgs(decl, [], EMPTY_ENV);
    return resolveTypeDeclWithArgs(decl, [], EMPTY_ENV);
}

function resolveTypeDecl(decl: TypeDeclaration | EnumDeclaration): string {
    return resolveNamedType(decl);
}

// ── Function type helpers ─────────────────────────────────────────────────────

/**
 * Resolve a TypeReference to the underlying function TypeReference if it is
 * (or aliases to) a function type.  Returns null otherwise.
 */
function resolveFnTypeRef(typeRef: TypeReference | undefined): TypeReference | null {
    if (!typeRef) return null;
    const tr = typeRef as any;
    if (tr.fnType) return typeRef;
    const decl = (typeRef.ref as any)?.ref as TypeDeclaration | undefined;
    if (decl?.body && isAliasBody(decl.body)) {
        return resolveFnTypeRef((decl.body as any).alias as TypeReference);
    }
    return null;
}

/**
 * Extract concrete parameter and return types from a function TypeReference,
 * correctly threading generic type-arguments through alias chains.
 *
 * Examples:
 *   extractFnTypeDetailsFromRef(fn(int): int, {})  → {paramTypes:['i32'], returnType:'i32'}
 *   extractFnTypeDetailsFromRef(Function<int,int>, {})  → same (type args threaded)
 *   extractFnTypeDetailsFromRef(fn(A): R, {A:'i32', R:'i32'})  → same
 */
function extractFnTypeDetailsFromRef(
    typeRef:  TypeReference | undefined,
    outerEnv: TypeEnv = EMPTY_ENV,
): { paramTypes: string[], returnType: string } | null {
    if (!typeRef) return null;
    const tr = typeRef as any;

    // Direct fn type: fn(T1, T2): R  or  fn(...A): R  (spread variant)
    if (tr.fnType) {
        let paramTypes: string[];
        if (tr.fnSpread) {
            // fn(...A): R — spread of a tuple type param (or a single type → wrap in list)
            const spreadTy = resolveTypeRefWithEnv(tr.fnSpread as TypeReference, outerEnv);
            paramTypes = isTupleEnc(spreadTy) ? decodeTuple(spreadTy)
                       : spreadTy === 'void'  ? []
                       : [spreadTy];
        } else {
            paramTypes = ((tr.fnParams ?? []) as any[]).map((p: any) =>
                p.type ? resolveTypeRefWithEnv(p.type as TypeReference, outerEnv) : 'i32'
            );
        }
        const returnType = tr.fnReturnType
            ? resolveTypeRefWithEnv(tr.fnReturnType as TypeReference, outerEnv)
            : 'void';
        return { paramTypes, returnType };
    }

    // Named type that may be a fn-type alias (e.g. Function<int, int>)
    const decl = (typeRef.ref as any)?.ref as TypeDeclaration | undefined;
    if (decl?.body && isAliasBody(decl.body)) {
        const params: TypeParam[]       = (decl as any).typeParams ?? [];
        const typeArgs: TypeReference[] = (tr.typeArgs ?? []) as TypeReference[];

        // Build inner env: map alias's type params → resolved type args,
        // falling back to defaultType when no explicit argument is supplied.
        const innerEnv = new Map(outerEnv);
        params.forEach((p, i) => {
            if (typeArgs[i]) {
                innerEnv.set(p.name, resolveTypeRefWithEnv(typeArgs[i], outerEnv));
            } else {
                const def = resolveTypeParamDefault(p, outerEnv);
                if (def !== undefined) innerEnv.set(p.name, def);
            }
        });

        const aliasRef = (decl.body as any).alias as TypeReference | undefined;
        return extractFnTypeDetailsFromRef(aliasRef, innerEnv);
    }
    return null;
}

/**
 * Extract concrete parameter and return types from a function TypeReference.
 * Handles inline fn types (fnType=true) and aliases that resolve to fn types.
 * Returns null when the TypeReference is not a function type.
 * @deprecated Prefer extractFnTypeDetailsFromRef which handles generic aliases.
 */
function extractFnTypeDetails(
    typeRef: TypeReference | undefined,
    env:     TypeEnv,
): { paramTypes: string[], returnType: string } | null {
    const fnRef = resolveFnTypeRef(typeRef);
    if (!fnRef) return null;
    const tr = fnRef as any;
    const paramTypes = ((tr.fnParams ?? []) as any[]).map((p: any) =>
        p.type ? resolveTypeRefWithEnv(p.type as TypeReference, env) : 'i32'
    );
    const returnType = tr.fnReturnType
        ? resolveTypeRefWithEnv(tr.fnReturnType as TypeReference, env)
        : 'void';
    return { paramTypes, returnType };
}

/**
 * Resolve the LLVM type of a function parameter, supporting optional type
 * annotations.  When `type` is omitted the type is inferred from the default
 * value expression (literals only; complex expressions fall back to `i32`).
 *
 *   fn f(n: int = 100)   → 'i32'   (explicit type wins)
 *   fn f(n = 100)        → 'i32'   (inferred from NumberLiteral)
 *   fn f(flag = true)    → 'i1'    (inferred from BoolLiteral)
 *   fn f(s = "hi")       → 'i8*'   (inferred from StringLiteral)
 *   fn f(x)              → 'i32'   (fallback — caller should annotate)
 */
function resolveParamType(p: Parameter): string {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (p.type) return resolveTypeRef(p.type!);
    if (p.defaultValue) {
        if (isNumberLiteral(p.defaultValue)) {
            const raw = (p.defaultValue as NumberLiteral).value;
            return String(raw).includes('.') ? 'double' : 'i32';
        }
        if (isStringLiteral(p.defaultValue) || isTemplateLiteral(p.defaultValue)) return 'i8*';
        if (isBoolLiteral(p.defaultValue)) return 'i1';
        // Unary minus on a number literal
        if (isUnaryExpr(p.defaultValue)) {
            const ue = p.defaultValue as UnaryExpr;
            if (isNumberLiteral(ue.operand)) {
                const raw = (ue.operand as NumberLiteral).value;
                return String(raw).includes('.') ? 'double' : 'i32';
            }
        }
    }
    return 'i32'; // fallback: bare untyped param without a recognisable default
}

/** Pointer type for `llvmTy`, translating unsigned sentinels first. */
function ptrOf(llvmTy: string): string { return `${toLLVM(llvmTy)}*`; }

function alignOf(llvmTy: string): number {
    // Unsigned sentinels and inf/negInf resolve to their LLVM equivalents.
    if (isUnsignedTy(llvmTy) || llvmTy === 'inf' || llvmTy === 'negInf') return alignOf(toLLVM(llvmTy));
    // Fixed-size array [N x T]: alignment equals element alignment
    const arrMatch = llvmTy.match(/^\[(\d+) x (.+)\]$/);
    if (arrMatch) return alignOf(arrMatch[2]);
    switch (llvmTy) {
        case 'i1':
        case 'i8':            return 1;
        case 'i16':           return 2;
        case 'i32':
        case 'float':         return 4;
        case 'i64':
        case 'double':
        case 'i8*':
        case '%Number*':
        case '{ i8*, i8* }':  return 8;   // pointer / fat-pointer struct
        case 'i128':          return 16;
        case 'i256':          return 32;
        case 'i512':          return 64;
        case '<2 x float>':   return 8;
        case '<4 x float>':   return 16;
        case '<6 x float>':   return 32;
        case '<8 x float>':   return 32;
        case '<16 x float>':  return 64;
        default:              return 8;
    }
}

/**
 * Return the byte size of an LLVM type string.
 * Used by `computeFieldOffset` to advance past a field when computing offsets.
 *
 * Rules:
 *   iN            → N/8  (e.g. i32 → 4, i64 → 8)
 *   float         → 4
 *   double        → 8
 *   <N x float>   → N*4
 *   [N x T]       → N * sizeOfLLVM(T)
 *   *-pointer     → 8   (64-bit address space)
 *   else          → 8   (conservative default for opaque types)
 */
function sizeOfLLVM(llvmTy: string): number {
    if (isUnsignedTy(llvmTy) || llvmTy === 'inf' || llvmTy === 'negInf') return sizeOfLLVM(toLLVM(llvmTy));
    // Fixed-size array [N x T]
    const arrMatch = llvmTy.match(/^\[(\d+) x (.+)\]$/);
    if (arrMatch) return parseInt(arrMatch[1], 10) * sizeOfLLVM(arrMatch[2]);
    // SIMD vector <N x float>
    const vecMatch = llvmTy.match(/^<(\d+) x float>$/);
    if (vecMatch) return parseInt(vecMatch[1], 10) * 4;
    // iN
    const iMatch = llvmTy.match(/^i(\d+)$/);
    if (iMatch) return Math.ceil(parseInt(iMatch[1], 10) / 8);
    switch (llvmTy) {
        case 'float':        return 4;
        case 'double':       return 8;
        case 'i1':           return 1;
    }
    // Pointer or opaque struct pointer — 8 bytes on 64-bit
    if (llvmTy.includes('*') || llvmTy.startsWith('%')) return 8;
    return 8;
}

/**
 * Compute a stable djb2 hash of a string, clamped to an unsigned 32-bit value.
 * Used by typeId!(T) to produce compile-time type identifiers.
 *
 *   hash = 5381
 *   for each char c:  hash = hash * 33 ^ charCode(c)
 *   result = hash >>> 0   (unsigned 32-bit)
 */
function djb2Hash(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
    }
    return h;
}

/**
 * Select the correct icmp / fcmp opcode for a comparison operator + type.
 * Unsigned integer types (u8…u512) use unsigned predicates (ult/ule/ugt/uge).
 */
function icmpOp(op: string, llvmTy: string): string {
    const f = isFloatTy(llvmTy);
    const u = isUnsignedTy(llvmTy);
    switch (op) {
        case '==': return f ? 'fcmp oeq' : 'icmp eq';
        case '!=': return f ? 'fcmp one' : 'icmp ne';
        case '<':  return f ? 'fcmp olt' : u ? 'icmp ult' : 'icmp slt';
        case '>':  return f ? 'fcmp ogt' : u ? 'icmp ugt' : 'icmp sgt';
        case '<=': return f ? 'fcmp ole' : u ? 'icmp ule' : 'icmp sle';
        case '>=': return f ? 'fcmp oge' : u ? 'icmp uge' : 'icmp sge';
        default:   return f ? 'fcmp oeq' : 'icmp eq';
    }
}

// ── Variable context ──────────────────────────────────────────────────────────

interface VarInfo {
    allocaName:    string;
    llvmType:      string;
    /** When llvmType === FNVAL_TY: the concrete parameter types of the function. */
    fnParamTypes?: string[];
    /** When llvmType === FNVAL_TY: the concrete return type of the function. */
    fnReturnType?: string;
}

type VarCtx = Map<string, VarInfo>;

interface ExtensionEntry {
    method:      ExtensionMethod;
    typeName:    string;       // e.g. "Boolean", "String"
    selfLlvmTy:  string;       // e.g. "i1", "i8*"
    isStatic:    boolean;      // true for static methods — no self parameter
}

/**
 * An extension method on a GENERIC type (one with type parameters).
 * Indexed by the TypeDeclaration's name (e.g. "Array") rather than the mangled
 * LLVM type, because the concrete LLVM type isn't known until instantiation.
 */
interface GenericExtEntry {
    method:     ExtensionMethod;
    typeDecl:   TypeDeclaration | EnumDeclaration;
    typeParams: TypeParam[];
}

// ── String-constant bookkeeping ───────────────────────────────────────────────

interface StrConst {
    globalName:  string;
    byteLen:     number;
    llvmEncoded: string;
}

const CONST_FN_ATTR = 0;

// ── Public entry point ────────────────────────────────────────────────────────

export function generateLLVMIR(modules: ResolvedModule[], sourceFile: string): string {
    const fnTable           = buildFnTable(modules);
    const nsTable           = buildNamespaceTable(modules);
    const externTable       = buildExternTable(modules);
    const extTable          = buildExtensionTable(modules);
    const staticTable       = buildStaticTable(modules);
    const genericExtIndex   = buildGenericExtensionIndex(modules);
    const structMethodTable = buildStructMethodTable(modules);

    // Merge struct method entries into the extension table
    for (const [llvmTy, methods] of structMethodTable) {
        if (!extTable.has(llvmTy)) extTable.set(llvmTy, new Map());
        for (const [name, entry] of methods) {
            extTable.get(llvmTy)!.set(name, entry);
        }
    }

    const staticPropsTable                               = buildStaticPropsTable(modules);
    const [protocolDefaultsTable, protocolStaticDefaults] = buildProtocolDefaultsTable(modules);

    // ── Inject protocol default instance methods into extTable ────────────────
    // When a type declares `TypeName extends Protocol {}` without overriding
    // a method that has a default body in the protocol, we synthesise an
    // ExtensionEntry so that instance dispatch (`c.toString()`) resolves to
    // the emitted `@TypeName_toString` function.
    //
    // Note: extTable is keyed by LLVM type, so two distinct CodeLang types that
    // share the same LLVM representation (e.g. two `intrinsic("i32")` types)
    // would collide here.  That is a pre-existing limitation of the dispatch
    // model; we preserve it rather than try to solve it here.
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isExtensionDeclaration(elem)) continue;
            const extDecl = elem as ExtensionDeclaration;
            if (!extDecl.protocol) continue;
            const defaults = protocolDefaultsTable.get(extDecl.protocol);
            if (!defaults) continue;
            const typeDecl = extDecl.typeName?.ref;
            if (!typeDecl) continue;
            const selfLlvmTy = resolveTypeDecl(typeDecl);
            const typeName   = typeDecl.name;
            const overriddenNames = new Set(extDecl.methods.map(m => m.name));
            for (const [methodName, sig] of defaults) {
                if (overriddenNames.has(methodName)) continue;
                if (!extTable.has(selfLlvmTy)) extTable.set(selfLlvmTy, new Map());
                // Only set if no explicit entry already exists for this LLVM type.
                if (!extTable.get(selfLlvmTy)!.has(methodName)) {
                    extTable.get(selfLlvmTy)!.set(methodName, {
                        method:     sig as unknown as ExtensionMethod,
                        typeName,
                        selfLlvmTy,
                        isStatic:   false,
                    });
                }
            }
        }
    }

    // ── Build quick protocol-field-names map ─────────────────────────────────
    // Maps protocol name → set of field names declared in that protocol.
    // Used below to decide whether a concrete type's default factory can be
    // injected (it can only if the type has no extra required fields).
    const protocolFieldNamesQuick = new Map<string, Set<string>>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isProtocolDeclaration(elem)) continue;
            const proto = elem as ProtocolDeclaration;
            const fset  = new Set<string>();
            for (const pf of proto.fields) fset.add(pf.name);
            protocolFieldNamesQuick.set(proto.name, fset);
        }
    }

    // Helper: returns true when a concrete NamedType has required struct fields
    // that are NOT declared in the given protocol's field list.
    // "Required" means no `= defaultExpr` in the field declaration.
    function typeHasExtraRequiredFields(namedType: TypeDeclaration | EnumDeclaration, protoName: string): boolean {
        if (!isTypeDeclaration(namedType)) return false;
        const typeDecl = namedType as TypeDeclaration;
        if (!isStructBody(typeDecl.body)) return false;
        const protoFields = protocolFieldNamesQuick.get(protoName) ?? new Set<string>();
        for (const member of (typeDecl.body as StructBody).members) {
            if (!isFieldDeclaration(member)) continue;
            const fd = member as FieldDeclaration;
            if (protoFields.has(fd.name)) continue; // field covered by protocol
            if ((fd as any).defaultValue !== undefined) continue; // has a default — OK
            return true; // extra required field
        }
        return false;
    }

    // ── Inject protocol default static methods into staticTable ───────────────
    // `static fn new(…) { … }` in a protocol becomes `TypeName_new` for each
    // conforming type that does not provide its own static `new` AND does not
    // have extra required fields beyond the protocol's declared fields.
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isExtensionDeclaration(elem)) continue;
            const extDecl = elem as ExtensionDeclaration;
            if (!extDecl.protocol) continue;
            const staticDefaults = protocolStaticDefaults.get(extDecl.protocol);
            if (!staticDefaults) continue;
            const typeDecl = extDecl.typeName?.ref;
            if (!typeDecl) continue;
            // Skip if the concrete type has extra required fields: the protocol's
            // default factory body only knows about the protocol's own fields.
            if (typeHasExtraRequiredFields(typeDecl, extDecl.protocol)) continue;
            const selfLlvmTy = resolveTypeDecl(typeDecl);
            const typeName   = typeDecl.name;
            const overriddenStaticNames = new Set(extDecl.methods.filter(m => m.static).map(m => m.name));
            for (const [methodName, sig] of staticDefaults) {
                if (overriddenStaticNames.has(methodName)) continue;
                if (!staticTable.has(typeName)) staticTable.set(typeName, new Map());
                if (!staticTable.get(typeName)!.has(methodName)) {
                    staticTable.get(typeName)!.set(methodName, {
                        method:     sig as unknown as ExtensionMethod,
                        typeName,
                        selfLlvmTy,
                        isStatic:   true,
                    });
                }
            }
        }
    }

    const fnValExtIndex = buildFnValExtIndex(modules);

    return new GeneratorContext(sourceFile, fnTable, nsTable, externTable, extTable, staticTable, genericExtIndex, staticPropsTable, protocolDefaultsTable, protocolStaticDefaults, fnValExtIndex).generate(modules);
}

/**
 * Map from LLVM type → method name → ExtensionEntry (instance methods only).
 * Static methods are excluded here and go into the staticTable instead.
 * Generic extensions (where the typeName has typeParams) are excluded here
 * and go into the genericExtIndex instead.
 */
function buildExtensionTable(modules: ResolvedModule[]): Map<string, Map<string, ExtensionEntry>> {
    const table = new Map<string, Map<string, ExtensionEntry>>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isExtensionDeclaration(elem)) continue;
            const extDecl = elem as ExtensionDeclaration;
            const typeDecl = extDecl.typeName?.ref;
            if (!typeDecl) continue;
            // Skip generic extension declarations — handled by genericExtIndex
            const extTypeParams: TypeParam[] = (extDecl as any).typeParams ?? [];
            if (extTypeParams.length > 0) continue;
            const selfLlvmTy = resolveTypeDecl(typeDecl);
            const typeName   = typeDecl.name;
            for (const method of extDecl.methods) {
                if (method.static) continue;  // static methods go into staticTable
                if (!table.has(selfLlvmTy)) table.set(selfLlvmTy, new Map());
                table.get(selfLlvmTy)!.set(method.name, { method, typeName, selfLlvmTy, isStatic: false });
            }
        }
    }
    // ── Inline enum methods (EnumMethod inside EnumDeclaration body) ─────────
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isEnumDeclaration(elem)) continue;
            const decl = elem as EnumDeclaration;
            if (decl.typeParams?.length > 0) continue; // skip generic enums
            const selfLlvmTy = `%${decl.name}*`;
            for (const member of decl.members) {
                if (!isEnumMethod(member)) continue;
                const em = member as EnumMethod;
                if (em.static) continue; // static enum methods go into staticTable
                if (!table.has(selfLlvmTy)) table.set(selfLlvmTy, new Map());
                table.get(selfLlvmTy)!.set(em.name, {
                    method:     em as unknown as ExtensionMethod,
                    typeName:   decl.name,
                    selfLlvmTy,
                    isStatic:   false,
                });
            }
        }
    }
    return table;
}

/**
 * Map from typeName → method name → ExtensionEntry (static methods only).
 * Keyed by the CodeLang type declaration name (e.g. "String", "Buffer") so that
 * `String.new(5)` dispatch resolves via `staticTable.get("String")`.
 * Generic extension static methods are excluded (no current support needed).
 */
function buildStaticTable(modules: ResolvedModule[]): Map<string, Map<string, ExtensionEntry>> {
    const table = new Map<string, Map<string, ExtensionEntry>>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            // ── Static methods from extension declarations ──────────────────────
            if (isExtensionDeclaration(elem)) {
                const extDecl = elem as ExtensionDeclaration;
                const typeDecl = extDecl.typeName?.ref;
                if (!typeDecl) continue;
                // Skip generic extension declarations for now
                const extTypeParams: TypeParam[] = (extDecl as any).typeParams ?? [];
                if (extTypeParams.length > 0) continue;
                const selfLlvmTy = resolveTypeDecl(typeDecl);
                const typeName   = typeDecl.name;
                for (const method of extDecl.methods) {
                    if (!method.static) continue;  // only static methods
                    if (!table.has(typeName)) table.set(typeName, new Map());
                    table.get(typeName)!.set(method.name, { method, typeName, selfLlvmTy, isStatic: true });
                }
            }
            // ── Static methods from struct body (type X { static fn ... }) ─────
            if (elem.$type === 'TypeDeclaration') {
                const typeDecl = elem as TypeDeclaration;
                if (!isStructBody(typeDecl.body)) continue;
                const typeName   = typeDecl.name;
                const selfLlvmTy = `%${typeName}*`;
                for (const member of (typeDecl.body as StructBody).members) {
                    if (isCallableMethod(member)) {
                        // CallableMethod is always static (no `self` parameter)
                        const cm = member as CallableMethod;
                        if (!table.has(typeName)) table.set(typeName, new Map());
                        table.get(typeName)!.set(cm.name, {
                            method:     cm as unknown as ExtensionMethod,
                            typeName,
                            selfLlvmTy,
                            isStatic:   true,
                        });
                        continue;
                    }
                    if (!isStructMethod(member)) continue;
                    const sm = member as StructMethod;
                    if (!sm.static) continue;
                    if (!table.has(typeName)) table.set(typeName, new Map());
                    table.get(typeName)!.set(sm.name, {
                        method:     sm as unknown as ExtensionMethod,
                        typeName,
                        selfLlvmTy,
                        isStatic:   true,
                    });
                }
            }
            // ── Static methods from enum body (enum X { static fn ... }) ──────
            if (isEnumDeclaration(elem)) {
                const decl = elem as EnumDeclaration;
                if (decl.typeParams?.length > 0) continue; // skip generic enums
                const typeName   = decl.name;
                const selfLlvmTy = `%${typeName}*`;
                for (const member of decl.members) {
                    if (!isEnumMethod(member)) continue;
                    const em = member as EnumMethod;
                    if (!em.static) continue;
                    if (!table.has(typeName)) table.set(typeName, new Map());
                    table.get(typeName)!.set(em.name, {
                        method:     em as unknown as ExtensionMethod,
                        typeName,
                        selfLlvmTy,
                        isStatic:   true,
                    });
                }
            }
        }
    }
    return table;
}

// ── Static property table ─────────────────────────────────────────────────────

/**
 * Entry in the static-props table.  Each `ExtensionProperty` is lowered to a
 * zero-arg LLVM function `@TypeName_PropName()` that evaluates the initializer.
 */
interface StaticPropEntry {
    typeName:   string;
    selfLlvmTy: string;
    property:   ExtensionProperty;
}

/**
 * Map from typeName → property name → StaticPropEntry.
 *
 * Example:
 *   `Number extends { export static Infinity: Number = number_infinity(); }`
 *   → staticPropsTable.get("Number").get("Infinity") = { ... }
 */
function buildStaticPropsTable(
    modules: ResolvedModule[],
): Map<string, Map<string, StaticPropEntry>> {
    const table = new Map<string, Map<string, StaticPropEntry>>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isExtensionDeclaration(elem)) continue;
            const extDecl  = elem as ExtensionDeclaration;
            const typeDecl = extDecl.typeName?.ref;
            if (!typeDecl) continue;
            const selfLlvmTy = resolveTypeDecl(typeDecl);
            const typeName   = typeDecl.name;
            for (const prop of extDecl.properties ?? []) {
                if (!table.has(typeName)) table.set(typeName, new Map());
                table.get(typeName)!.set(prop.name, { typeName, selfLlvmTy, property: prop });
            }
        }
    }
    return table;
}

/**
 * Map from protocol name → method name → MethodSignature, for signatures that
 * carry a default body.  Used to inject the default implementation for any
 * conforming type that does not provide its own override.
 *
 * The returned tuple contains two separate tables:
 *   [0] — instance method defaults (no `static` flag)
 *   [1] — static method defaults   (`static` flag set)
 *
 * Example:
 *   protocol Displayable { fn toString(): string { return "[Displayable]: default"; } }
 *   → instanceDefaults.get("Displayable").get("toString") = <MethodSignature>
 *
 *   protocol Error extends Displayable {
 *     static fn new(name: string) { … }
 *   }
 *   → staticDefaults.get("Error").get("new") = <MethodSignature>
 */
function buildProtocolDefaultsTable(
    modules: ResolvedModule[],
): [Map<string, Map<string, MethodSignature>>, Map<string, Map<string, MethodSignature>>] {
    const instance = new Map<string, Map<string, MethodSignature>>();
    const statics  = new Map<string, Map<string, MethodSignature>>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isProtocolDeclaration(elem)) continue;
            const proto = elem as ProtocolDeclaration;
            for (const sig of proto.signatures) {
                if (!sig.body) continue;  // abstract signature — skip
                const table = (sig as any).static ? statics : instance;
                if (!table.has(proto.name)) table.set(proto.name, new Map());
                table.get(proto.name)!.set(sig.name, sig);
            }
        }
    }
    return [instance, statics];
}

/**
 * Map from TypeDeclaration name → method name → GenericExtEntry.
 * Covers extension declarations on generic types (typeName has typeParams).
 *
 * Example: `Array<T> extends { fn push(v: T) { ... } }`
 *   → genericExtIndex.get("Array").get("push") = { method, typeDecl, typeParams: [T] }
 */
function buildGenericExtensionIndex(
    modules: ResolvedModule[],
): Map<string, Map<string, GenericExtEntry>> {
    const index = new Map<string, Map<string, GenericExtEntry>>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isExtensionDeclaration(elem)) continue;
            const extDecl = elem as ExtensionDeclaration;
            const typeDecl = extDecl.typeName?.ref;
            if (!typeDecl) continue;
            const extTypeParams: TypeParam[] = (extDecl as any).typeParams ?? [];
            if (extTypeParams.length === 0) continue;  // only generic extensions
            const typeName = typeDecl.name;
            for (const method of extDecl.methods) {
                if (method.static) continue;  // static generic methods not yet supported
                if (!index.has(typeName)) index.set(typeName, new Map());
                index.get(typeName)!.set(method.name, { method, typeDecl, typeParams: extTypeParams });
            }
        }
    }
    return index;
}

/**
 * Build an index of extension methods defined on fat-pointer (fn-val) type aliases.
 *
 * E.g., `Function<A,R> extends { fn call(arg: A): R { ... } }`
 *   → fnValExtIndex.get("call") = { method, typeDecl, typeParams: [A, R] }
 *
 * Keyed by method name (fat pointers are all the same LLVM type `{ i8*, i8* }`).
 */
function buildFnValExtIndex(
    modules: ResolvedModule[],
): Map<string, GenericExtEntry> {
    const index = new Map<string, GenericExtEntry>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (!isExtensionDeclaration(elem)) continue;
            const extDecl  = elem as ExtensionDeclaration;
            const typeDecl = extDecl.typeName?.ref;
            if (!typeDecl) continue;
            const extTypeParams: TypeParam[] = (extDecl as any).typeParams ?? [];
            if (extTypeParams.length === 0) continue;
            // Resolve the self type with placeholder env — if it's a fat pointer, track it
            const selfTy = resolveTypeDecl(typeDecl);
            if (selfTy !== FNVAL_TY) continue;
            for (const method of extDecl.methods) {
                if (method.static) continue;
                index.set(method.name, { method, typeDecl, typeParams: extTypeParams });
            }
        }
    }
    return index;
}

/**
 * Given a fn-alias TypeDeclaration (e.g. `type Function<A, R> = fn(A): R`)
 * and concrete fnParamTypes/fnReturnType, build the TypeEnv by matching the
 * alias body's fn-type parameter/return-type positions to the concrete types.
 */
function buildTypeEnvFromFnAlias(
    typeDecl:       TypeDeclaration,
    fnParamTypes:   string[],
    fnReturnType:   string,
): Map<string, string> {
    const env = new Map<string, string>();
    if (!typeDecl.body || !isAliasBody(typeDecl.body)) return env;
    const aliasRef = (typeDecl.body as AliasBody).alias as any;
    if (!aliasRef?.fnType) return env;

    if (aliasRef.fnSpread) {
        // fn(...A): R — bind the spread type param to a tuple encoding of all param types.
        // For single-param functions, bind to the raw type (no tuple) for backward compat.
        const spreadName = aliasRef.fnSpread?.ref?.$refText as string | undefined;
        if (spreadName) {
            env.set(spreadName,
                fnParamTypes.length === 1 ? fnParamTypes[0] : encodeTuple(fnParamTypes));
        }
    } else {
        const fnParams: any[] = aliasRef.fnParams ?? [];
        for (let i = 0; i < fnParams.length && i < fnParamTypes.length; i++) {
            const pName = fnParams[i]?.type?.ref?.$refText as string | undefined;
            if (pName) env.set(pName, fnParamTypes[i]);
        }
    }
    const retName = aliasRef.fnReturnType?.ref?.$refText as string | undefined;
    if (retName) env.set(retName, fnReturnType);
    return env;
}

/**
 * Build an extension-method table from struct body methods inside TypeDeclarations.
 *
 * For each `type Foo = { fn bar() { ... } }`, adds an `ExtensionEntry` keyed by
 * the struct LLVM type `%Foo*` → method name → entry.
 * Merged into the regular extTable so that `foo.bar()` dispatch works normally.
 */
function buildStructMethodTable(modules: ResolvedModule[]): Map<string, Map<string, ExtensionEntry>> {
    const table = new Map<string, Map<string, ExtensionEntry>>();
    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            if (elem.$type !== 'TypeDeclaration') continue;
            const typeDecl = elem as TypeDeclaration;
            if (!isStructBody(typeDecl.body)) continue;
            const typeName   = typeDecl.name;
            const selfLlvmTy = `%${typeName}*`;
            for (const member of (typeDecl.body as StructBody).members) {
                if (!isStructMethod(member)) continue;
                const sm = member as StructMethod;
                if (sm.static) continue;  // static struct methods not yet supported
                // Convert StructMethod to an ExtensionMethod-compatible object
                const methodAsExt = sm as unknown as ExtensionMethod;
                if (!table.has(selfLlvmTy)) table.set(selfLlvmTy, new Map());
                table.get(selfLlvmTy)!.set(sm.name, {
                    method:     methodAsExt,
                    typeName,
                    selfLlvmTy,
                    isStatic:   false,
                });
            }
        }
    }
    return table;
}

function buildExternTable(modules: ResolvedModule[]): Map<string, ExternDeclaration> {
    const t = new Map<string, ExternDeclaration>();
    for (const mod of modules)
        for (const elem of mod.program.elements)
            if (isExternDeclaration(elem)) t.set(elem.name, elem);
    return t;
}

/** Flat name → FunctionDeclaration table (plain calls and bare-import targets). */
function buildFnTable(modules: ResolvedModule[]): Map<string, FunctionDeclaration> {
    const t = new Map<string, FunctionDeclaration>();
    for (const mod of modules) {
        for (const elem of mod.program.elements)
            if (isFunctionDeclaration(elem)) t.set(elem.name, elem);
    }
    return t;
}

/**
 * Namespace name → ResolvedModule map.
 *
 * For every `const x = import "./foo"` in any module, maps `x` to the
 * corresponding ResolvedModule so that `x.bar()` can resolve `bar`.
 */
function buildNamespaceTable(modules: ResolvedModule[]): Map<string, ResolvedModule> {
    const t = new Map<string, ResolvedModule>();
    // Build a lookup map by absolute path for efficient resolution
    const byAbsPath = new Map<string, ResolvedModule>(modules.map(m => [m.filePath, m]));

    for (const mod of modules) {
        for (const elem of mod.program.elements) {
            const fromDir = nodePath.dirname(mod.filePath);

            // Regular namespace import: const g = import "./greetings"
            if (isNamespaceImport(elem)) {
                const spec = elem.source;
                let target: ResolvedModule | undefined;
                const specNoExt = spec.endsWith('.code') ? spec : `${spec}.code`;
                const candidates = [
                    nodePath.resolve(fromDir, specNoExt),
                    nodePath.resolve(fromDir, spec, 'index.code'),
                    nodePath.resolve(fromDir, spec),
                ];
                for (const candidate of candidates) {
                    target = byAbsPath.get(candidate);
                    if (target) break;
                }
                if (target) t.set(elem.name, target);
                continue;
            }

            // Conditional import: const x = switch_import! compile.arch() { ... }
            if (isSwitchImport(elem)) {
                const condValue = evalCompileCondition(elem.condObj, elem.condMethod);
                let selectedSpec: string | undefined = elem.elsePath;
                for (const arm of elem.arms) {
                    if (arm.pattern === condValue) { selectedSpec = arm.path; break; }
                }
                if (!selectedSpec) continue;
                try {
                    const absPath = resolveModulePath(selectedSpec, fromDir);
                    const target  = byAbsPath.get(absPath);
                    if (target) t.set(elem.name, target);
                } catch { /* resolution error already reported during module loading */ }
                continue;
            }
        }
    }
    return t;
}

// ── Template-string utilities ─────────────────────────────────────────────────

interface TemplatePart {
    kind:  'literal' | 'hole';
    text:  string;  // literal text (after unescape) or raw hole content
}

/**
 * Parse the raw TEMPLATE_STRING token value (e.g. `$"hello {name}!"`) into
 * an alternating sequence of literal parts and expression holes.
 *
 * The outer `$"..."` wrapper is stripped; escape sequences are resolved in
 * literal parts; hole contents are returned verbatim for the mini-parser.
 *
 * Hole detection rule: `{` starts a hole ONLY when the very next character is
 * an identifier-start or digit (`[_a-zA-Z0-9]`).  A `{` followed by a space,
 * newline, `}`, or end-of-string is treated as a literal brace character.
 * This lets you write `$"Point { x: {x}, y: {y} }"` naturally — the outer
 * `{` / `}` are literal and only `{x}` / `{y}` are holes.
 * To force a literal `{` before an identifier, use the `\{` escape.
 */
function parseTemplateParts(raw: string): TemplatePart[] {
    // Strip the leading $" and the trailing "
    const inner = raw.slice(2, -1);
    const parts: TemplatePart[] = [];
    let i = 0, lit = '';

    while (i < inner.length) {
        // ── Escape sequences ────────────────────────────────────────────────
        // Handle \{ and \} before brace detection so that a backslash can
        // always force a literal brace even when followed by an identifier.
        // Other escape sequences (\n, \t, \\, \", …) are left raw in `lit`
        // and resolved later by unescapeTemplate().
        if (inner[i] === '\\' && i + 1 < inner.length) {
            const esc = inner[i + 1];
            if (esc === '{' || esc === '}') {
                lit += esc;   // consume: \{ → {,  \} → }
                i += 2;
                continue;
            }
            // Pass other escape pairs through verbatim for unescapeTemplate
            lit += inner[i];
            lit += esc;
            i += 2;
            continue;
        }

        // ── Hole detection ──────────────────────────────────────────────────
        if (inner[i] === '{') {
            // Only treat { as a hole-start when immediately followed by an
            // identifier char or digit.  Otherwise it is a literal '{'.
            const next = inner[i + 1] ?? '';
            if (/[_a-zA-Z0-9]/.test(next)) {
                // Flush accumulated literal characters
                if (lit.length > 0) {
                    parts.push({ kind: 'literal', text: unescapeTemplate(lit) });
                    lit = '';
                }
                // Collect hole content — brace-depth tracking handles nested {}.
                let depth = 1, j = i + 1, hole = '';
                while (j < inner.length && depth > 0) {
                    if (inner[j] === '{') depth++;
                    else if (inner[j] === '}') { depth--; if (depth === 0) break; }
                    hole += inner[j];
                    j++;
                }
                parts.push({ kind: 'hole', text: hole.trim() });
                i = j + 1;  // skip past the closing '}'
            } else {
                // Literal brace — accumulate and continue
                lit += inner[i];
                i++;
            }
        } else {
            lit += inner[i];
            i++;
        }
    }
    if (lit.length > 0) {
        parts.push({ kind: 'literal', text: unescapeTemplate(lit) });
    }
    return parts;
}

/** Resolve standard escape sequences in the literal portions of a template. */
function unescapeTemplate(s: string): string {
    let result = '';
    let i = 0;
    while (i < s.length) {
        if (s[i] === '\\' && i + 1 < s.length) {
            switch (s[i + 1]) {
                case 'n':  result += '\n'; i += 2; break;
                case 't':  result += '\t'; i += 2; break;
                case 'r':  result += '\r'; i += 2; break;
                case '\\': result += '\\'; i += 2; break;
                case '"':  result += '"';  i += 2; break;
                case '{':  result += '{';  i += 2; break;
                case '0':  result += '\0'; i += 2; break;
                default:
                    result += s[i + 1];
                    i += 2;
            }
        } else {
            result += s[i];
            i++;
        }
    }
    return result;
}

// ── Mini expression parser for template holes ─────────────────────────────────
//
// Grammar (subset of CodeLang expressions):
//   expr        → addSub
//   addSub      → mulDiv (('+' | '-') mulDiv)*
//   mulDiv      → atom (('*' | '/' | '%') atom)*
//   atom        → NUMBER
//               | ID '(' argList ')'           -- free call:   slug(model)
//               | ID ('.' ID)+ '(' argList ')' -- method call: OS.hostname()
//               | ID ('.' ID)*                 -- id / member: self.data.field
//               | '(' expr ')'
//   argList     → (expr (',' expr)*)?
//
// Calls produce `call` / `method_call` nodes so emitMiniExpr can route them
// through the static-dispatch and namespace-lookup pipelines.

type MiniExpr =
    | { kind: 'num';         value:  number }
    | { kind: 'id';          name:   string }
    | { kind: 'call';        name:   string; args: MiniExpr[] }
    | { kind: 'member';      obj:    string; fields: string[] }
    | { kind: 'method_call'; obj:    string; method: string; args: MiniExpr[] }
    | { kind: 'bin';         op: string; left: MiniExpr; right: MiniExpr };

function parseMiniExpr(input: string): MiniExpr {
    const tokens = tokenizeMini(input.trim());
    let pos = 0;

    const peek  = (): string => tokens[pos] ?? '';
    const next  = (): string => tokens[pos++] ?? '';

    function parseExpr(): MiniExpr  { return parseAddSub(); }

    function parseAddSub(): MiniExpr {
        let left = parseMulDiv();
        while (peek() === '+' || peek() === '-') {
            const op = next();
            left = { kind: 'bin', op, left, right: parseMulDiv() };
        }
        return left;
    }

    function parseMulDiv(): MiniExpr {
        let left = parseAtom();
        while (peek() === '*' || peek() === '/' || peek() === '%') {
            const op = next();
            left = { kind: 'bin', op, left, right: parseAtom() };
        }
        return left;
    }

    function parseArgList(): MiniExpr[] {
        const args: MiniExpr[] = [];
        while (peek() !== ')' && peek() !== '') {
            args.push(parseExpr());
            if (peek() === ',') next();
        }
        if (peek() === ')') next(); // consume ')'
        return args;
    }

    function parseAtom(): MiniExpr {
        const t = next();
        if (t === '(') {
            const e = parseExpr();
            next(); // consume ')'
            return e;
        }
        if (/^[0-9]+(\.[0-9]+)?$/.test(t)) return { kind: 'num', value: parseFloat(t) };
        if (/^[_a-zA-Z]\w*$/.test(t)) {
            // Free function call: ID(args)
            if (peek() === '(') {
                next(); // consume '('
                return { kind: 'call', name: t, args: parseArgList() };
            }
            // Consume any `.field` suffixes to build a member-access chain
            const fields: string[] = [];
            while (peek() === '.' && /^[_a-zA-Z]\w*$/.test(tokens[pos + 1] ?? '')) {
                next(); // consume '.'
                fields.push(next()); // consume field name
            }
            // Method call: obj[.intermediates].method(args)
            if (fields.length > 0 && peek() === '(') {
                next(); // consume '('
                const method = fields[fields.length - 1];
                return { kind: 'method_call', obj: t, method, args: parseArgList() };
            }
            return fields.length > 0
                ? { kind: 'member', obj: t, fields }
                : { kind: 'id', name: t };
        }
        return { kind: 'num', value: 0 }; // fallback
    }

    return parseExpr();
}

function tokenizeMini(input: string): string[] {
    const tokens: string[] = [];
    // Include '.' as a token so member access (self.data) can be parsed.
    // Numbers with decimals (3.14) are captured first by the leading alternative
    // so their dot is never emitted as a separate '.' token.
    const re = /([0-9]+(?:\.[0-9]+)?|[_a-zA-Z]\w*|[+\-*\/%(),.])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) tokens.push(m[1]);
    return tokens;
}

// ── Defer bookkeeping ─────────────────────────────────────────────────────────
//
// Two deferred-call flavours are tracked per-function:
//   expr    — a raw Expression from a `defer <expr>` statement
//   dispose — a synthesised `<varName>.dispose()` from a `using` declaration

type DeferTarget =
    | { kind: 'expr';    expr:    Expression }
    | { kind: 'dispose'; varName: string     };

// ── Generator class ───────────────────────────────────────────────────────────

class GeneratorContext {
    private readonly strMap    = new Map<string, StrConst>();
    /** Raw string constants (no trailing \n) — used for function call arguments. */
    private readonly rawStrMap = new Map<string, StrConst>();
    private strIdx          = 0;
    private tmpIdx          = 0;
    private ifIdx           = 0;
    private currentLabel    = 'entry';
    /**
     * Stack of enclosing loop labels.  Each entry covers one loop level.
     *   continueLabel — where `continue` should branch
     *                    (for `while`: the condition check block;
     *                     for `for`:  the update block)
     *   breakLabel    — where `break` should branch (the merge / post-loop block)
     */
    private loopStack: { continueLabel: string; breakLabel: string }[] = [];
    private emittedConstFn  = false;
    /** True when at least one Number value is used — adds runtime declarations. */
    private usesNumber      = false;
    private usesBuffer       = false;
    /** True when stdlib/tui.code's TuiBuffer is used — adds %TuiBuffer = type opaque. */
    private usesTuiBuffer    = false;
    private usesIntArray        = false;
    private usesStringArray     = false;
    private usesNumberArray     = false;
    private usesAnyArray        = false;
    private usesBoolArray       = false;
    private usesPtrArray        = false;
    private usesIntSet          = false;
    private usesStringSet       = false;
    private usesBoolSet         = false;
    private usesFloatArray      = false;
    private usesDoubleArray     = false;
    private usesFloatSet        = false;
    private usesDoubleSet       = false;
    private usesNumberSet       = false;
    private usesIntIntMap       = false;
    private usesIntStringMap    = false;
    private usesStringIntMap    = false;
    private usesStringStringMap = false;
    private usesIntPtrMap       = false;
    private usesStringPtrMap    = false;
    private usesPtrIntMap       = false;
    private usesPtrStrMap       = false;
    private usesPtrPtrMap       = false;
    private usesMatrix          = false;   // stdlib/npu.code — Matrix opaque type
    private usesCoreML          = false;   // stdlib/npu/apple_coreml.code — CoreMLModel + QuantizedMatrix
    private usesAsync           = false;   // stdlib/async.code — Task/Context/Shared/Scheduler
    /** Auto-generated helper LLVM IR functions (struct toString, struct-array toString). */
    private autoGeneratedFunctions: string[] = [];
    /**
     * Tracks which auto-generated functions have already been emitted.
     * Prevents duplicate definitions when multiple print(ptrArrayVar) statements
     * reference the same struct element type.
     */
    private emittedAutoFunctions = new Set<string>();
    /**
     * Maps alloca name (e.g. '%users') → struct element type name (e.g. 'User').
     * Populated when a variable of type Array<StructType> or StructType[] is declared.
     * Used to determine the element type for PtrArray print / toString generation.
     */
    private ptrArrayElemMap = new Map<string, string>();
    /**
     * True when at least one built-in string method (`length`, `at`) is called
     * without importing stdlib/string (i.e., via the inline built-in path).
     * Triggers emitting `declare` stubs for the C runtime functions used.
     */
    private usesStringBuiltins = false;
    /**
     * True when at least one template literal uses numeric or boolean holes.
     * Triggers emitting declares for `int_to_string`, `float_to_string` and
     * (when multi-part) `concat` — functions defined in runtime/string.c.
     */
    private usesIntToString    = false;
    private usesIntDigitCount  = false;
    private usesFloatToString  = false;
    private usesNumberToString = false;
    /** True when a template literal needs `concat` and it is not already declared
     *  via the stdlib/string extern import. */
    private needsConcatDecl   = false;
    /** True when a switch string-pattern arm uses strcmp and it is not already declared. */
    private needsStrcmpDecl   = false;
    /**
     * True when `print(bufferExpr)` is used and buffer_print is not yet declared
     * via a stdlib/buffer extern import.  Triggers a conditional `declare`.
     */
    private needsBufferPrintDecl           = false;
    private needsIntArrayPrintDecl        = false;
    private needsStringArrayPrintDecl     = false;
    private needsNumberArrayPrintDecl     = false;
    private needsAnyArrayPrintDecl        = false;
    private needsBoolArrayPrintDecl       = false;
    private needsIntSetPrintDecl          = false;
    private needsStringSetPrintDecl       = false;
    private needsBoolSetPrintDecl         = false;
    private needsFloatArrayPrintDecl      = false;
    private needsDoubleArrayPrintDecl     = false;
    private needsFloatSetPrintDecl        = false;
    private needsDoubleSetPrintDecl       = false;
    private needsNumberSetPrintDecl       = false;
    private needsIntIntMapPrintDecl       = false;
    private needsIntStringMapPrintDecl    = false;
    private needsStringIntMapPrintDecl    = false;
    private needsStringStringMapPrintDecl = false;
    private needsIntPtrMapPrintDecl       = false;
    private needsStringPtrMapPrintDecl    = false;
    private needsPtrIntMapPrintDecl       = false;
    private needsPtrStrMapPrintDecl       = false;
    private needsPtrPtrMapPrintDecl       = false;
    // get/put declares for maps whose stdlib skips those externs (void* handling)
    private needsIntPtrMapGetDecl         = false;
    private needsIntPtrMapPutDecl         = false;
    private needsStringPtrMapGetDecl      = false;
    private needsStringPtrMapPutDecl      = false;
    private needsPtrPtrMapGetDecl         = false;
    private needsPtrPtrMapPutDecl         = false;
    /** True when a `panic(expr)` statement is used and runtime_panic is not yet
     * declared via an extern import. */
    private needsPanicDecl = false;
    /** True when `flush()` built-in is used and fflush is not yet declared. */
    private needsFflushDecl = false;
    /** True when `codelang_readline` is needed (not imported via io.code). */
    private needsReadLineDecl = false;
    /** True when `codelang_readall` is needed (not imported via io.code). */
    private needsReadAllDecl = false;
    /** True when `codelang_make_args` is needed (main accepts args parameter). */
    private needsMakeArgsDecl = false;
    /** Declared return type of the function currently being emitted (for auto-cast). */
    private currentFnRetTy  = 'void';
    /** True while emitting a `const fn` — enables musttail tail-call elimination. */
    private currentFnIsConst = false;
    /**
     * Non-null when the current function is auto-memoized.
     * Points to the LLVM global name for the per-function memo slot (without '@').
     */
    private currentMemoGlobal: string | null = null;
    /**
     * Alloca name ('%name') of the single const-Number parameter being used as
     * the memo key.  Null when memoization is inactive.
     */
    private currentMemoParamAlloca: string | null = null;
    /**
     * Deferred calls for the function currently being emitted.
     * Flushed (LIFO) immediately before every `ret` instruction.
     * Saved/restored across nested function / extension-method emissions.
     */
    private currentDefers: DeferTarget[] = [];

    /**
     * Name of the struct type currently being emitted (for `Self` resolution inside
     * static struct methods and struct literals).  Null outside a struct method.
     */
    private currentStructContext: string | null = null;

    /**
     * Name of the parent type of the struct currently being emitted
     * (used to dispatch `super.method()` calls).
     * Null when the current type has no parent, or when outside a struct method.
     */
    private currentParentType: string | null = null;

    /**
     * Maps child struct name → parent type name.
     * Populated during `collectStructInfo` for every `type Foo extends Bar { … }`.
     */
    private readonly parentTypeMap = new Map<string, string>();

    /**
     * Set of struct names that have a `CallableMethod` named `call` (or a
     * `static fn call`), enabling `TypeName(args)` → `@TypeName_call(args)` sugar.
     */
    private readonly callableStructs = new Set<string>();

    /**
     * Set of protocol names (from `ProtocolDeclaration`).
     * Used in `collectStructInfo` to skip adding `_parent` fields for protocol parents.
     */
    private readonly protocolSet = new Set<string>();

    /**
     * Maps protocol name → set of field names declared in that protocol.
     * Used to determine whether a concrete type has extra required fields beyond
     * the protocol's declared fields, in which case the protocol's default static
     * factory cannot be applied.
     * Populated during `collectStructInfo`.
     */
    private readonly protocolFieldNames = new Map<string, Set<string>>();

    // ── Nested / local function support ──────────────────────────────────────────
    /**
     * LLVM name of the function currently being compiled.
     * Used to mangle nested function names: `outer.inner`.
     */
    private currentFnName: string = '';

    /**
     * Local (nested) functions that have been declared so far in the current
     * function body.  Maps simple source name → { fn, mangledName }.
     * Checked first in emitCallInstr before fnTable / externTable.
     */
    private localFnScope: Map<string, { fn: FunctionDeclaration; mangledName: string }> = new Map();

    /**
     * Local functions queued for emission after the current function body.
     * Populated in emitStatement when a FunctionDeclaration node is encountered
     * inside a block; drained in emitFunction after the closing `}`.
     */
    private pendingLocalFns: Array<{ fn: FunctionDeclaration; mangledName: string }> = [];

    /**
     * All local function names declared anywhere in the current block (pre-scanned).
     * Used for forward-reference detection: if a call names a function that IS in
     * this set but NOT yet in localFnScope, it is a forward reference.
     */
    private blockLocalFnNames: Set<string> = new Set();

    /** Set of LLVM type strings that need `= type opaque` declarations (generic instantiations). */
    private genericOpaqueDecls = new Set<string>();
    /**
     * Maps struct type name (e.g. "Point") → ordered array of field info.
     * Used for GEP-based field access codegen and struct header emission.
     * Populated during `collectStructInfo`.
     */
    private readonly structFieldMap = new Map<string, Array<{
        name: string;
        llvmType: string;
        /** True when the field is declared `const` (read-only after construction). */
        readonly?: boolean;
        /**
         * True when the field's *type* carries the `const` qualifier (`const T`).
         * This pins the value's representation — no auto-promotion to a wider or
         * heap-allocated type at runtime (e.g. `const Number` stays as i64).
         */
        constType?: boolean;
        /** True for fixed-size embedded array fields, e.g. `data: Int[5]`. */
        isFixedArray?: boolean;
        /** Number of elements for a fixed-size array field. */
        arraySize?: number;
        /** Compile-time initializer values for `const data: Int[5; ...] = [...]`. */
        arrayInitValues?: number[];
        /** True when the field is declared `using` (auto-dispose on scope exit). */
        isDisposable?: boolean;
        /**
         * Optional default value expression from the field declaration:
         *   `x: int = 0`      → NumberLiteral { value: 0 }
         *   `s: string = "hi"` → StringLiteral { value: "hi" }
         * When present, the struct literal may omit this field and the default is emitted.
         */
        defaultValue?: Expression;
    }>>();
    /**
     * Maps struct type name → ordered array of method metadata.
     * Used by `emitTypeInfoIntrinsic` to reflect struct methods.
     * Populated during `collectStructInfo`.
     */
    private readonly structMethodMetaMap = new Map<string, Array<{
        name: string;
        /** True when the method is declared `export`. */
        isExportable: boolean;
        /** True when the method is declared `const` (comptime). */
        isConst: boolean;
        /** CodeLang-readable return type (e.g. "int", "string", "Point"). */
        returnType: string;
    }>>();
    /**
     * Maps struct type name → TypeDeclaration, for struct header + constructor emission.
     */
    private readonly structTypeDecls = new Map<string, TypeDeclaration>();
    /**
     * Struct type names that declare an explicit `static fn new()` in their body.
     * For these types the auto-generated `@TypeName_new(fields...)` constructor is
     * NOT emitted — the explicit method is the constructor.
     */
    private readonly structsWithExplicitNew = new Set<string>();
    /** Set of mangled specialization names already emitted (to avoid duplicates). */
    private emittedSpecializations = new Set<string>();
    /**
     * Maps type name → TypeDeclaration for every type that appears in the
     * current compilation's module graph.  Used to resolve ambiguous cross-
     * references: when Langium resolves a type annotation to a declaration
     * from an out-of-graph stdlib file (e.g. `stdlib/buffer.code`'s `Buffer`
     * even though only `stdlib/tui.code` is imported), we use this map to
     * substitute the correct in-graph declaration instead.
     */
    private readonly graphTypeDeclByName = new Map<string, TypeDeclaration>();

    // ── Enum support ──────────────────────────────────────────────────────────────
    /** Maps enum name → EnumDeclaration AST node. */
    private readonly enumDeclMap = new Map<string, EnumDeclaration>();
    /**
     * Maps enumName → (variantName → integer tag value).
     * Populated by collectEnumInfo().
     */
    private readonly enumVariantTags = new Map<string, Map<string, number>>();
    /**
     * Tracks concrete generic enum instantiations:
     *   mangled base name (e.g. "Option_i32") → { decl, env }
     * Populated during collectGenericInstantiations.
     */
    private readonly enumInstantiations = new Map<string, { decl: EnumDeclaration; env: Map<string, string> }>();
    /** Set of enum constructor function names already emitted (avoids duplicates). */
    private readonly emittedEnumCtors = new Set<string>();

    // ── Higher-order function / closure support ───────────────────────────────
    /** Counter for generating unique lambda function names (`__lambda_0`, …). */
    private lambdaIdx = 0;
    /** Deferred lambda function definitions — emitted after all regular functions. */
    private lambdaLines: string[] = [];
    /** Deferred named-function wrapper definitions — emitted after regular functions. */
    private wrapperLines: string[] = [];
    /** Set of wrapper function names already emitted (avoids duplicate definitions). */
    private emittedWrappers = new Set<string>();
    /** True when at least one capturing lambda is used — triggers `declare i8* @malloc`. */
    private usesMalloc = false;
    /** Env-struct type declarations for closures — emitted in the module header. */
    private envStructDecls: string[] = [];
    /**
     * Set of extension-method mangled names already emitted.
     * Prevents duplicate LLVM function definitions when the same extension method
     * could be reached via multiple code paths (e.g. separate extension blocks
     * for the same type, or future multi-file scenarios).
     */
    private readonly emittedExtensionMethods = new Set<string>();
    /**
     * Pending generic specializations: maps mangledName → { fn, env }.
     * Populated when a generic call is emitted; flushed after all regular functions.
     */
    private pendingSpecializations = new Map<string, { fn: FunctionDeclaration; env: Map<string, string> }>();

    /**
     * Maps mangled LLVM type (e.g. "%Container_i32*") → { typeDecl, env }.
     * Populated during collectGenericInstantiations when a TypeReference with
     * explicit typeArgs is encountered (e.g. `let a: Container<int>`).
     * Used to dispatch method calls on generic-type receivers.
     */
    private readonly mangledTypeIndex = new Map<string, { typeDecl: TypeDeclaration; env: Map<string, string> }>();

    /**
     * Maps mangled LLVM type (e.g. "%Option_i32*") → { decl: EnumDeclaration, env }.
     * Populated during collectGenericInstantiations when a generic enum TypeReference is
     * encountered (e.g. `let a: Option<int>`).
     * Used to dispatch inline method calls on generic enum receivers.
     */
    private readonly mangledEnumTypeIndex = new Map<string, { decl: EnumDeclaration; env: Map<string, string> }>();

    /**
     * Pending generic enum inline method specializations.
     * Maps mangledName (e.g. "Option_i32_isSome") → { method, selfLlvmTy, typeEnv }.
     * Flushed after all regular extension methods are emitted.
     */
    private readonly pendingGenericEnumSpecs = new Map<string, {
        method:    EnumMethod;
        selfLlvmTy: string;
        typeEnv:   ReadonlyMap<string, string>;
    }>();

    /** Tracks already-emitted generic enum method specializations to prevent duplicates. */
    private readonly emittedEnumMethodSpecs = new Set<string>();

    /**
     * Pending generic extension method specializations.
     * Maps mangledName (e.g. "Container_i32_id") → { method, selfLlvmTy, typeEnv }.
     * Flushed after all regular extension methods are emitted.
     */
    private readonly pendingGenericExtSpecs = new Map<string, {
        method:           ExtensionMethod;
        selfLlvmTy:       string;
        typeEnv:          ReadonlyMap<string, string>;
        /** Only set when selfLlvmTy is a fat-pointer fn-val { i8*, i8* } */
        selfFnParamTypes?: string[];
        selfFnReturnType?: string;
    }>();

    /**
     * TypeEnv active during generic extension method body emission.
     * Set to EMPTY_ENV outside of generic extension specializations.
     * Used by varDeclType and emitUsingDecl to resolve T-typed local variables.
     */
    private currentTypeEnv: ReadonlyMap<string, string> = EMPTY_ENV;

    private readonly externTable:      Map<string, ExternDeclaration>;
    private readonly extTable:         Map<string, Map<string, ExtensionEntry>>;
    /** typeName → method name → ExtensionEntry for static dispatch (Type.method()). */
    private readonly staticTable:      Map<string, Map<string, ExtensionEntry>>;
    /** TypeDeclaration name → method name → GenericExtEntry for generic type dispatch. */
    private readonly genericExtIndex:  Map<string, Map<string, GenericExtEntry>>;
    /** typeName → prop name → StaticPropEntry for property-style access (Type.Prop). */
    private readonly staticPropsTable:      Map<string, Map<string, StaticPropEntry>>;
    /** protocol name → method name → MethodSignature with a default body (instance). */
    private readonly protocolDefaultsTable: Map<string, Map<string, MethodSignature>>;
    /** protocol name → method name → MethodSignature with a default body (static). */
    private readonly protocolStaticDefaults: Map<string, Map<string, MethodSignature>>;
    /** method name → GenericExtEntry for extension methods on fat-pointer (fn-val) type aliases. */
    private readonly fnValExtIndex:         Map<string, GenericExtEntry>;

    constructor(
        private readonly sourceFile: string,
        private readonly fnTable:    Map<string, FunctionDeclaration>,
        private readonly nsTable:    Map<string, ResolvedModule>,
        externTable:              Map<string, ExternDeclaration>                  = new Map(),
        extTable:                 Map<string, Map<string, ExtensionEntry>>        = new Map(),
        staticTable:              Map<string, Map<string, ExtensionEntry>>        = new Map(),
        genericExtIndex:          Map<string, Map<string, GenericExtEntry>>       = new Map(),
        staticPropsTable:         Map<string, Map<string, StaticPropEntry>>       = new Map(),
        protocolDefaultsTable:    Map<string, Map<string, MethodSignature>>       = new Map(),
        protocolStaticDefaults:   Map<string, Map<string, MethodSignature>>       = new Map(),
        fnValExtIndex:            Map<string, GenericExtEntry>                    = new Map(),
    ) {
        this.externTable            = externTable;
        this.extTable               = extTable;
        this.staticTable            = staticTable;
        this.genericExtIndex        = genericExtIndex;
        this.staticPropsTable       = staticPropsTable;
        this.protocolDefaultsTable  = protocolDefaultsTable;
        this.protocolStaticDefaults = protocolStaticDefaults;
        this.fnValExtIndex          = fnValExtIndex;
    }

    generate(modules: ResolvedModule[]): string {
        // Build the graph-type map so that ambiguous cross-references (where
        // Langium resolves to a same-named type from an unimported stdlib file)
        // can be redirected to the correct in-graph declaration.
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isTypeDeclaration(elem)) {
                    this.graphTypeDeclByName.set(elem.name, elem);
                    // Detect stdlib/tui.code's TuiBuffer opaque type so we can
                    // emit `%TuiBuffer = type opaque` in the IR header.
                    if (isIntrinsicBody(elem.body) &&
                        (elem.body.llvmType === '%TuiBuffer*' || elem.body.llvmType.includes('TuiBuffer'))) {
                        this.usesTuiBuffer = true;
                    }
                }
            }
        }

        // Pre-intern string constants required by built-in type methods so that
        // they are emitted in the global-constants section before functions.
        this.rawInternString('true');
        this.rawInternString('false');

        // Pass 0: process top-level compileError! calls (platform guards etc.)
        // Run before any string collection so the error fires as early as possible.
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isTopLevelMacroCall(elem) && elem.callee === 'compileError') {
                    this.emitMacroCompileError(elem.args);
                }
            }
        }

        // Pass 1: collect all string literals
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isFunctionDeclaration(elem)) {
                    for (const stmt of elem.body.statements) {
                        this.collectStringsInStmt(stmt);
                        this.collectRawStringsInReturnStmts(stmt);
                    }
                }
            }
        }
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        for (const stmt of method.body.statements) {
                            this.collectStringsInStmt(stmt);
                            this.collectRawStringsInReturnStmts(stmt);
                        }
                    }
                }
                // Scan ALL methods inside struct bodies (both static and instance,
                // including CallableMethod which has no `fn` keyword)
                if (elem.$type === 'TypeDeclaration' && isStructBody((elem as TypeDeclaration).body)) {
                    for (const member of ((elem as TypeDeclaration).body as StructBody).members) {
                        if (!isStructMethod(member) && !isCallableMethod(member)) continue;
                        const methodBody = isCallableMethod(member)
                            ? (member as CallableMethod).body
                            : (member as StructMethod).body;
                        for (const stmt of methodBody.statements) {
                            this.collectStringsInStmt(stmt);
                            this.collectRawStringsInReturnStmts(stmt);
                        }
                    }
                }
                // Scan inline enum methods (EnumMethod inside EnumDeclaration body)
                if (isEnumDeclaration(elem)) {
                    for (const member of (elem as EnumDeclaration).members) {
                        if (!isEnumMethod(member)) continue;
                        for (const stmt of (member as EnumMethod).body.statements) {
                            this.collectStringsInStmt(stmt);
                            this.collectRawStringsInReturnStmts(stmt);
                        }
                    }
                }
            }
        }
        // Collect strings from protocol default bodies
        for (const [, methods] of this.protocolDefaultsTable) {
            for (const [, sig] of methods) {
                if (sig.body) {
                    for (const stmt of sig.body.statements) {
                        this.collectStringsInStmt(stmt);
                        this.collectRawStringsInReturnStmts(stmt);
                    }
                }
            }
        }

        // Collect struct type info early so we can decide whether malloc is needed
        this.collectStructInfo(modules);

        // ── Mark types that receive a protocol-default `new` ─────────────────
        // These types must NOT also get an auto-generated struct constructor
        // (both would be named `TypeName_new` and would collide in the IR).
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (!isExtensionDeclaration(elem)) continue;
                const extDecl = elem as ExtensionDeclaration;
                if (!extDecl.protocol) continue;
                const staticDefaults = this.protocolStaticDefaults.get(extDecl.protocol);
                if (!staticDefaults?.has('new')) continue;
                const typeDecl = extDecl.typeName?.ref;
                if (!typeDecl || !isTypeDeclaration(typeDecl)) continue;
                // Skip types that explicitly override `new`
                const overridesNew = extDecl.methods.some(m => m.static && m.name === 'new');
                if (overridesNew) continue;
                // Skip types with extra required fields (they won't receive the default)
                const protoFields = this.protocolFieldNames.get(extDecl.protocol) ?? new Set<string>();
                const concreteFields = this.structFieldMap.get(typeDecl.name) ?? [];
                const hasExtraRequired = concreteFields.some(
                    f => !protoFields.has(f.name) && !f.defaultValue && !f.isFixedArray
                );
                if (hasExtraRequired) continue;
                // This type WILL receive the protocol's default `new` — suppress the auto-ctor
                this.structsWithExplicitNew.add(typeDecl.name);
            }
        }
        // Also suppress auto-ctor for types whose plain (non-protocol) extension blocks
        // declare `static fn new()` — they would collide with the auto-generated constructor.
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (!isExtensionDeclaration(elem)) continue;
                const extDecl = elem as ExtensionDeclaration;
                if (extDecl.protocol) continue; // protocol extensions handled above
                const typeDecl = extDecl.typeName?.ref;
                if (!typeDecl || !isTypeDeclaration(typeDecl)) continue;
                const hasNew = extDecl.methods.some(m => m.static && m.name === 'new');
                if (hasNew) this.structsWithExplicitNew.add(typeDecl.name);
            }
        }

        // Collect enum declarations and assign variant tags
        this.collectEnumInfo(modules);

        // Process @derive(Displayable) — registers fake extTable entries for toString
        this.collectDerivedDecorators(modules);

        // ── Scan for Number / Buffer / IntArray / StringArray type usage ─────────
        // These scans run before funcs generation so that the opaque type declarations
        // are correctly included in the header.  The same approach is used for
        // usesReflection (via externTable / extTable membership tests).

        // ── Number ──────────────────────────────────────────────────────────────
        numberSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isFunctionDeclaration(elem)) {
                    if (this.fnUsesNumber(elem)) { this.usesNumber = true; break numberSearch; }
                }
                if (isExternDeclaration(elem)) {
                    const ext = elem as ExternDeclaration;
                    if (resolveTypeRef(ext.returnType) === NUMBER_TY) { this.usesNumber = true; break numberSearch; }
                    for (const p of ext.parameters)
                        if (resolveParamType(p) === NUMBER_TY) { this.usesNumber = true; break numberSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    const extDecl = elem as ExtensionDeclaration;
                    // The extension target type itself may be Number (e.g. "Number extends Countable")
                    if (extDecl.typeName?.ref?.name === 'Number') {
                        this.usesNumber = true; break numberSearch;
                    }
                    for (const method of extDecl.methods) {
                        if (method.returnType && resolveTypeRef(method.returnType) === NUMBER_TY) {
                            this.usesNumber = true; break numberSearch;
                        }
                        for (const p of method.parameters)
                            if (resolveParamType(p) === NUMBER_TY) { this.usesNumber = true; break numberSearch; }
                    }
                }
            }
        }

        // ── Buffer ───────────────────────────────────────────────────────────────
        bufferSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isBufferTy(resolveTypeRef(elem.returnType))) { this.usesBuffer = true; break bufferSearch; }
                    for (const p of elem.parameters)
                        if (isBufferTy(resolveParamType(p))) { this.usesBuffer = true; break bufferSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isBufferTy(resolveTypeRef(fn.returnType))) { this.usesBuffer = true; break bufferSearch; }
                    for (const p of fn.parameters)
                        if (isBufferTy(resolveParamType(p))) { this.usesBuffer = true; break bufferSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isBufferTy(resolveTypeRef(method.returnType))) {
                            this.usesBuffer = true; break bufferSearch;
                        }
                        for (const p of method.parameters)
                            if (isBufferTy(resolveParamType(p))) { this.usesBuffer = true; break bufferSearch; }
                    }
                }
            }
        }

        // ── IntArray ─────────────────────────────────────────────────────────────
        intarraySearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isIntArrayTy(resolveTypeRef(elem.returnType))) { this.usesIntArray = true; break intarraySearch; }
                    for (const p of elem.parameters)
                        if (isIntArrayTy(resolveParamType(p))) { this.usesIntArray = true; break intarraySearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isIntArrayTy(resolveTypeRef(fn.returnType))) { this.usesIntArray = true; break intarraySearch; }
                    for (const p of fn.parameters)
                        if (isIntArrayTy(resolveParamType(p))) { this.usesIntArray = true; break intarraySearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isIntArrayTy(resolveTypeRef(method.returnType))) {
                            this.usesIntArray = true; break intarraySearch;
                        }
                        for (const p of method.parameters)
                            if (isIntArrayTy(resolveParamType(p))) { this.usesIntArray = true; break intarraySearch; }
                    }
                }
            }
        }

        // ── StringArray ──────────────────────────────────────────────────────────
        stringarraySearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isStringArrayTy(resolveTypeRef(elem.returnType))) { this.usesStringArray = true; break stringarraySearch; }
                    for (const p of elem.parameters)
                        if (isStringArrayTy(resolveParamType(p))) { this.usesStringArray = true; break stringarraySearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isStringArrayTy(resolveTypeRef(fn.returnType))) { this.usesStringArray = true; break stringarraySearch; }
                    for (const p of fn.parameters)
                        if (isStringArrayTy(resolveParamType(p))) { this.usesStringArray = true; break stringarraySearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isStringArrayTy(resolveTypeRef(method.returnType))) {
                            this.usesStringArray = true; break stringarraySearch;
                        }
                        for (const p of method.parameters)
                            if (isStringArrayTy(resolveParamType(p))) { this.usesStringArray = true; break stringarraySearch; }
                    }
                }
            }
        }

        // ── NumberArray ──────────────────────────────────────────────────────────
        numberarraySearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isNumberArrayTy(resolveTypeRef(elem.returnType))) { this.usesNumberArray = true; break numberarraySearch; }
                    for (const p of elem.parameters)
                        if (isNumberArrayTy(resolveParamType(p))) { this.usesNumberArray = true; break numberarraySearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isNumberArrayTy(resolveTypeRef(fn.returnType))) { this.usesNumberArray = true; break numberarraySearch; }
                    for (const p of fn.parameters)
                        if (isNumberArrayTy(resolveParamType(p))) { this.usesNumberArray = true; break numberarraySearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isNumberArrayTy(resolveTypeRef(method.returnType))) {
                            this.usesNumberArray = true; break numberarraySearch;
                        }
                        for (const p of method.parameters)
                            if (isNumberArrayTy(resolveParamType(p))) { this.usesNumberArray = true; break numberarraySearch; }
                    }
                }
            }
        }

        // ── AnyArray ─────────────────────────────────────────────────────────────
        anyarraySearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isAnyArrayTy(resolveTypeRef(elem.returnType))) { this.usesAnyArray = true; break anyarraySearch; }
                    for (const p of elem.parameters)
                        if (isAnyArrayTy(resolveParamType(p))) { this.usesAnyArray = true; break anyarraySearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isAnyArrayTy(resolveTypeRef(fn.returnType))) { this.usesAnyArray = true; break anyarraySearch; }
                    for (const p of fn.parameters)
                        if (isAnyArrayTy(resolveParamType(p))) { this.usesAnyArray = true; break anyarraySearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isAnyArrayTy(resolveTypeRef(method.returnType))) {
                            this.usesAnyArray = true; break anyarraySearch;
                        }
                        for (const p of method.parameters)
                            if (isAnyArrayTy(resolveParamType(p))) { this.usesAnyArray = true; break anyarraySearch; }
                    }
                }
            }
        }

        // ── BoolArray ─────────────────────────────────────────────────────────────
        boolarraySearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isBoolArrayTy(resolveTypeRef(elem.returnType))) { this.usesBoolArray = true; break boolarraySearch; }
                    for (const p of elem.parameters)
                        if (isBoolArrayTy(resolveParamType(p))) { this.usesBoolArray = true; break boolarraySearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isBoolArrayTy(resolveTypeRef(fn.returnType))) { this.usesBoolArray = true; break boolarraySearch; }
                    for (const p of fn.parameters)
                        if (isBoolArrayTy(resolveParamType(p))) { this.usesBoolArray = true; break boolarraySearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isBoolArrayTy(resolveTypeRef(method.returnType))) {
                            this.usesBoolArray = true; break boolarraySearch;
                        }
                        for (const p of method.parameters)
                            if (isBoolArrayTy(resolveParamType(p))) { this.usesBoolArray = true; break boolarraySearch; }
                    }
                }
            }
        }

        // ── PtrArray (struct-element arrays) ─────────────────────────────────────
        // PtrArray is used when Array<T> or T[] contains a user-defined struct type.
        // We detect usage by checking for %PtrArray* in declarations AND by scanning
        // for any T[] / Array<T> where T resolves to a named struct pointer → %PtrArray*.
        ptrarraySearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isPtrArrayTy(resolveTypeRef(elem.returnType))) { this.usesPtrArray = true; break ptrarraySearch; }
                    for (const p of elem.parameters)
                        if (isPtrArrayTy(resolveParamType(p))) { this.usesPtrArray = true; break ptrarraySearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isPtrArrayTy(resolveTypeRef(fn.returnType))) { this.usesPtrArray = true; break ptrarraySearch; }
                    for (const p of fn.parameters)
                        if (isPtrArrayTy(resolveParamType(p))) { this.usesPtrArray = true; break ptrarraySearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isPtrArrayTy(resolveTypeRef(method.returnType))) {
                            this.usesPtrArray = true; break ptrarraySearch;
                        }
                        for (const p of method.parameters)
                            if (isPtrArrayTy(resolveParamType(p))) { this.usesPtrArray = true; break ptrarraySearch; }
                    }
                }
            }
        }

        // ── IntSet ────────────────────────────────────────────────────────────────
        intsetSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isIntSetTy(resolveTypeRef(elem.returnType))) { this.usesIntSet = true; break intsetSearch; }
                    for (const p of elem.parameters)
                        if (isIntSetTy(resolveParamType(p))) { this.usesIntSet = true; break intsetSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isIntSetTy(resolveTypeRef(fn.returnType))) { this.usesIntSet = true; break intsetSearch; }
                    for (const p of fn.parameters)
                        if (isIntSetTy(resolveParamType(p))) { this.usesIntSet = true; break intsetSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isIntSetTy(resolveTypeRef(method.returnType))) {
                            this.usesIntSet = true; break intsetSearch;
                        }
                        for (const p of method.parameters)
                            if (isIntSetTy(resolveParamType(p))) { this.usesIntSet = true; break intsetSearch; }
                    }
                }
            }
        }

        // ── StringSet ─────────────────────────────────────────────────────────────
        stringsetSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isStringSetTy(resolveTypeRef(elem.returnType))) { this.usesStringSet = true; break stringsetSearch; }
                    for (const p of elem.parameters)
                        if (isStringSetTy(resolveParamType(p))) { this.usesStringSet = true; break stringsetSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isStringSetTy(resolveTypeRef(fn.returnType))) { this.usesStringSet = true; break stringsetSearch; }
                    for (const p of fn.parameters)
                        if (isStringSetTy(resolveParamType(p))) { this.usesStringSet = true; break stringsetSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isStringSetTy(resolveTypeRef(method.returnType))) {
                            this.usesStringSet = true; break stringsetSearch;
                        }
                        for (const p of method.parameters)
                            if (isStringSetTy(resolveParamType(p))) { this.usesStringSet = true; break stringsetSearch; }
                    }
                }
            }
        }

        // ── BoolSet ───────────────────────────────────────────────────────────────
        boolsetSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isBoolSetTy(resolveTypeRef(elem.returnType))) { this.usesBoolSet = true; break boolsetSearch; }
                    for (const p of elem.parameters)
                        if (isBoolSetTy(resolveParamType(p))) { this.usesBoolSet = true; break boolsetSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isBoolSetTy(resolveTypeRef(fn.returnType))) { this.usesBoolSet = true; break boolsetSearch; }
                    for (const p of fn.parameters)
                        if (isBoolSetTy(resolveParamType(p))) { this.usesBoolSet = true; break boolsetSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isBoolSetTy(resolveTypeRef(method.returnType))) {
                            this.usesBoolSet = true; break boolsetSearch;
                        }
                        for (const p of method.parameters)
                            if (isBoolSetTy(resolveParamType(p))) { this.usesBoolSet = true; break boolsetSearch; }
                    }
                }
            }
        }

        // ── FloatArray ────────────────────────────────────────────────────────────
        floatarraySearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isFloatArrayTy(resolveTypeRef(elem.returnType))) { this.usesFloatArray = true; break floatarraySearch; }
                    for (const p of elem.parameters)
                        if (isFloatArrayTy(resolveParamType(p))) { this.usesFloatArray = true; break floatarraySearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isFloatArrayTy(resolveTypeRef(fn.returnType))) { this.usesFloatArray = true; break floatarraySearch; }
                    for (const p of fn.parameters)
                        if (isFloatArrayTy(resolveParamType(p))) { this.usesFloatArray = true; break floatarraySearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isFloatArrayTy(resolveTypeRef(method.returnType))) {
                            this.usesFloatArray = true; break floatarraySearch;
                        }
                        for (const p of method.parameters)
                            if (isFloatArrayTy(resolveParamType(p))) { this.usesFloatArray = true; break floatarraySearch; }
                    }
                }
            }
        }

        // ── DoubleArray ───────────────────────────────────────────────────────────
        doublearraySearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isDoubleArrayTy(resolveTypeRef(elem.returnType))) { this.usesDoubleArray = true; break doublearraySearch; }
                    for (const p of elem.parameters)
                        if (isDoubleArrayTy(resolveParamType(p))) { this.usesDoubleArray = true; break doublearraySearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isDoubleArrayTy(resolveTypeRef(fn.returnType))) { this.usesDoubleArray = true; break doublearraySearch; }
                    for (const p of fn.parameters)
                        if (isDoubleArrayTy(resolveParamType(p))) { this.usesDoubleArray = true; break doublearraySearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isDoubleArrayTy(resolveTypeRef(method.returnType))) {
                            this.usesDoubleArray = true; break doublearraySearch;
                        }
                        for (const p of method.parameters)
                            if (isDoubleArrayTy(resolveParamType(p))) { this.usesDoubleArray = true; break doublearraySearch; }
                    }
                }
            }
        }

        // ── FloatSet ──────────────────────────────────────────────────────────────
        floatsetSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isFloatSetTy(resolveTypeRef(elem.returnType))) { this.usesFloatSet = true; break floatsetSearch; }
                    for (const p of elem.parameters)
                        if (isFloatSetTy(resolveParamType(p))) { this.usesFloatSet = true; break floatsetSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isFloatSetTy(resolveTypeRef(fn.returnType))) { this.usesFloatSet = true; break floatsetSearch; }
                    for (const p of fn.parameters)
                        if (isFloatSetTy(resolveParamType(p))) { this.usesFloatSet = true; break floatsetSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isFloatSetTy(resolveTypeRef(method.returnType))) {
                            this.usesFloatSet = true; break floatsetSearch;
                        }
                        for (const p of method.parameters)
                            if (isFloatSetTy(resolveParamType(p))) { this.usesFloatSet = true; break floatsetSearch; }
                    }
                }
            }
        }

        // ── DoubleSet ─────────────────────────────────────────────────────────────
        doublesetSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isDoubleSetTy(resolveTypeRef(elem.returnType))) { this.usesDoubleSet = true; break doublesetSearch; }
                    for (const p of elem.parameters)
                        if (isDoubleSetTy(resolveParamType(p))) { this.usesDoubleSet = true; break doublesetSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isDoubleSetTy(resolveTypeRef(fn.returnType))) { this.usesDoubleSet = true; break doublesetSearch; }
                    for (const p of fn.parameters)
                        if (isDoubleSetTy(resolveParamType(p))) { this.usesDoubleSet = true; break doublesetSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isDoubleSetTy(resolveTypeRef(method.returnType))) {
                            this.usesDoubleSet = true; break doublesetSearch;
                        }
                        for (const p of method.parameters)
                            if (isDoubleSetTy(resolveParamType(p))) { this.usesDoubleSet = true; break doublesetSearch; }
                    }
                }
            }
        }

        // ── NumberSet ─────────────────────────────────────────────────────────────
        numbersetSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isNumberSetTy(resolveTypeRef(elem.returnType))) { this.usesNumberSet = true; break numbersetSearch; }
                    for (const p of elem.parameters)
                        if (isNumberSetTy(resolveParamType(p))) { this.usesNumberSet = true; break numbersetSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isNumberSetTy(resolveTypeRef(fn.returnType))) { this.usesNumberSet = true; break numbersetSearch; }
                    for (const p of fn.parameters)
                        if (isNumberSetTy(resolveParamType(p))) { this.usesNumberSet = true; break numbersetSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isNumberSetTy(resolveTypeRef(method.returnType))) {
                            this.usesNumberSet = true; break numbersetSearch;
                        }
                        for (const p of method.parameters)
                            if (isNumberSetTy(resolveParamType(p))) { this.usesNumberSet = true; break numbersetSearch; }
                    }
                }
            }
        }

        // ── IntIntMap ─────────────────────────────────────────────────────────────
        intintmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isIntIntMapTy(resolveTypeRef(elem.returnType))) { this.usesIntIntMap = true; break intintmapSearch; }
                    for (const p of elem.parameters)
                        if (isIntIntMapTy(resolveParamType(p))) { this.usesIntIntMap = true; break intintmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isIntIntMapTy(resolveTypeRef(fn.returnType))) { this.usesIntIntMap = true; break intintmapSearch; }
                    for (const p of fn.parameters)
                        if (isIntIntMapTy(resolveParamType(p))) { this.usesIntIntMap = true; break intintmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isIntIntMapTy(resolveTypeRef(method.returnType))) {
                            this.usesIntIntMap = true; break intintmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isIntIntMapTy(resolveParamType(p))) { this.usesIntIntMap = true; break intintmapSearch; }
                    }
                }
            }
        }

        // ── IntStringMap ──────────────────────────────────────────────────────────
        intstringmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isIntStringMapTy(resolveTypeRef(elem.returnType))) { this.usesIntStringMap = true; break intstringmapSearch; }
                    for (const p of elem.parameters)
                        if (isIntStringMapTy(resolveParamType(p))) { this.usesIntStringMap = true; break intstringmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isIntStringMapTy(resolveTypeRef(fn.returnType))) { this.usesIntStringMap = true; break intstringmapSearch; }
                    for (const p of fn.parameters)
                        if (isIntStringMapTy(resolveParamType(p))) { this.usesIntStringMap = true; break intstringmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isIntStringMapTy(resolveTypeRef(method.returnType))) {
                            this.usesIntStringMap = true; break intstringmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isIntStringMapTy(resolveParamType(p))) { this.usesIntStringMap = true; break intstringmapSearch; }
                    }
                }
            }
        }

        // ── StringIntMap ──────────────────────────────────────────────────────────
        stringintmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isStringIntMapTy(resolveTypeRef(elem.returnType))) { this.usesStringIntMap = true; break stringintmapSearch; }
                    for (const p of elem.parameters)
                        if (isStringIntMapTy(resolveParamType(p))) { this.usesStringIntMap = true; break stringintmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isStringIntMapTy(resolveTypeRef(fn.returnType))) { this.usesStringIntMap = true; break stringintmapSearch; }
                    for (const p of fn.parameters)
                        if (isStringIntMapTy(resolveParamType(p))) { this.usesStringIntMap = true; break stringintmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isStringIntMapTy(resolveTypeRef(method.returnType))) {
                            this.usesStringIntMap = true; break stringintmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isStringIntMapTy(resolveParamType(p))) { this.usesStringIntMap = true; break stringintmapSearch; }
                    }
                }
            }
        }

        // ── StringStringMap ───────────────────────────────────────────────────────
        stringstringmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isStringStringMapTy(resolveTypeRef(elem.returnType))) { this.usesStringStringMap = true; break stringstringmapSearch; }
                    for (const p of elem.parameters)
                        if (isStringStringMapTy(resolveParamType(p))) { this.usesStringStringMap = true; break stringstringmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isStringStringMapTy(resolveTypeRef(fn.returnType))) { this.usesStringStringMap = true; break stringstringmapSearch; }
                    for (const p of fn.parameters)
                        if (isStringStringMapTy(resolveParamType(p))) { this.usesStringStringMap = true; break stringstringmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isStringStringMapTy(resolveTypeRef(method.returnType))) {
                            this.usesStringStringMap = true; break stringstringmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isStringStringMapTy(resolveParamType(p))) { this.usesStringStringMap = true; break stringstringmapSearch; }
                    }
                }
            }
        }

        // ── IntPtrMap ─────────────────────────────────────────────────────────────
        intptrmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isIntPtrMapTy(resolveTypeRef(elem.returnType))) { this.usesIntPtrMap = true; break intptrmapSearch; }
                    for (const p of elem.parameters)
                        if (isIntPtrMapTy(resolveParamType(p))) { this.usesIntPtrMap = true; break intptrmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isIntPtrMapTy(resolveTypeRef(fn.returnType))) { this.usesIntPtrMap = true; break intptrmapSearch; }
                    for (const p of fn.parameters)
                        if (isIntPtrMapTy(resolveParamType(p))) { this.usesIntPtrMap = true; break intptrmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isIntPtrMapTy(resolveTypeRef(method.returnType))) {
                            this.usesIntPtrMap = true; break intptrmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isIntPtrMapTy(resolveParamType(p))) { this.usesIntPtrMap = true; break intptrmapSearch; }
                    }
                }
            }
        }

        // ── StringPtrMap ──────────────────────────────────────────────────────────
        stringptrmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isStringPtrMapTy(resolveTypeRef(elem.returnType))) { this.usesStringPtrMap = true; break stringptrmapSearch; }
                    for (const p of elem.parameters)
                        if (isStringPtrMapTy(resolveParamType(p))) { this.usesStringPtrMap = true; break stringptrmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isStringPtrMapTy(resolveTypeRef(fn.returnType))) { this.usesStringPtrMap = true; break stringptrmapSearch; }
                    for (const p of fn.parameters)
                        if (isStringPtrMapTy(resolveParamType(p))) { this.usesStringPtrMap = true; break stringptrmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isStringPtrMapTy(resolveTypeRef(method.returnType))) {
                            this.usesStringPtrMap = true; break stringptrmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isStringPtrMapTy(resolveParamType(p))) { this.usesStringPtrMap = true; break stringptrmapSearch; }
                    }
                }
            }
        }

        // ── PtrIntMap ─────────────────────────────────────────────────────────────
        ptrintmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isPtrIntMapTy(resolveTypeRef(elem.returnType))) { this.usesPtrIntMap = true; break ptrintmapSearch; }
                    for (const p of elem.parameters)
                        if (isPtrIntMapTy(resolveParamType(p))) { this.usesPtrIntMap = true; break ptrintmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isPtrIntMapTy(resolveTypeRef(fn.returnType))) { this.usesPtrIntMap = true; break ptrintmapSearch; }
                    for (const p of fn.parameters)
                        if (isPtrIntMapTy(resolveParamType(p))) { this.usesPtrIntMap = true; break ptrintmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isPtrIntMapTy(resolveTypeRef(method.returnType))) {
                            this.usesPtrIntMap = true; break ptrintmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isPtrIntMapTy(resolveParamType(p))) { this.usesPtrIntMap = true; break ptrintmapSearch; }
                    }
                }
            }
        }

        // ── PtrStringMap ──────────────────────────────────────────────────────────
        ptrstrmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isPtrStrMapTy(resolveTypeRef(elem.returnType))) { this.usesPtrStrMap = true; break ptrstrmapSearch; }
                    for (const p of elem.parameters)
                        if (isPtrStrMapTy(resolveParamType(p))) { this.usesPtrStrMap = true; break ptrstrmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isPtrStrMapTy(resolveTypeRef(fn.returnType))) { this.usesPtrStrMap = true; break ptrstrmapSearch; }
                    for (const p of fn.parameters)
                        if (isPtrStrMapTy(resolveParamType(p))) { this.usesPtrStrMap = true; break ptrstrmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isPtrStrMapTy(resolveTypeRef(method.returnType))) {
                            this.usesPtrStrMap = true; break ptrstrmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isPtrStrMapTy(resolveParamType(p))) { this.usesPtrStrMap = true; break ptrstrmapSearch; }
                    }
                }
            }
        }

        // ── PtrPtrMap ─────────────────────────────────────────────────────────────
        ptrptrmapSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isPtrPtrMapTy(resolveTypeRef(elem.returnType))) { this.usesPtrPtrMap = true; break ptrptrmapSearch; }
                    for (const p of elem.parameters)
                        if (isPtrPtrMapTy(resolveParamType(p))) { this.usesPtrPtrMap = true; break ptrptrmapSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isPtrPtrMapTy(resolveTypeRef(fn.returnType))) { this.usesPtrPtrMap = true; break ptrptrmapSearch; }
                    for (const p of fn.parameters)
                        if (isPtrPtrMapTy(resolveParamType(p))) { this.usesPtrPtrMap = true; break ptrptrmapSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isPtrPtrMapTy(resolveTypeRef(method.returnType))) {
                            this.usesPtrPtrMap = true; break ptrptrmapSearch;
                        }
                        for (const p of method.parameters)
                            if (isPtrPtrMapTy(resolveParamType(p))) { this.usesPtrPtrMap = true; break ptrptrmapSearch; }
                    }
                }
            }
        }

        // ── Matrix (stdlib/npu.code) ──────────────────────────────────────────────
        matrixSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isMatrixTy(resolveTypeRef(elem.returnType))) { this.usesMatrix = true; break matrixSearch; }
                    for (const p of elem.parameters)
                        if (isMatrixTy(resolveParamType(p))) { this.usesMatrix = true; break matrixSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isMatrixTy(resolveTypeRef(fn.returnType))) { this.usesMatrix = true; break matrixSearch; }
                    for (const p of fn.parameters)
                        if (isMatrixTy(resolveParamType(p))) { this.usesMatrix = true; break matrixSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isMatrixTy(resolveTypeRef(method.returnType))) {
                            this.usesMatrix = true; break matrixSearch;
                        }
                        for (const p of method.parameters)
                            if (isMatrixTy(resolveParamType(p))) { this.usesMatrix = true; break matrixSearch; }
                    }
                }
            }
        }

        // ── CoreML (stdlib/npu/apple_coreml.code) ────────────────────────────────
        coremlSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isCoreMLTy(resolveTypeRef(elem.returnType))) { this.usesCoreML = true; break coremlSearch; }
                    for (const p of elem.parameters)
                        if (isCoreMLTy(resolveParamType(p))) { this.usesCoreML = true; break coremlSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isCoreMLTy(resolveTypeRef(fn.returnType))) { this.usesCoreML = true; break coremlSearch; }
                    for (const p of fn.parameters)
                        if (isCoreMLTy(resolveParamType(p))) { this.usesCoreML = true; break coremlSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isCoreMLTy(resolveTypeRef(method.returnType))) {
                            this.usesCoreML = true; break coremlSearch;
                        }
                        for (const p of method.parameters)
                            if (isCoreMLTy(resolveParamType(p))) { this.usesCoreML = true; break coremlSearch; }
                    }
                }
            }
        }

        // ── Async (stdlib/async.code) ─────────────────────────────────────────────
        asyncSearch: for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isExternDeclaration(elem)) {
                    if (isAsyncTy(resolveTypeRef(elem.returnType))) { this.usesAsync = true; break asyncSearch; }
                    for (const p of elem.parameters)
                        if (isAsyncTy(resolveParamType(p))) { this.usesAsync = true; break asyncSearch; }
                }
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    if (fn.returnType && isAsyncTy(resolveTypeRef(fn.returnType))) { this.usesAsync = true; break asyncSearch; }
                    for (const p of fn.parameters)
                        if (isAsyncTy(resolveParamType(p))) { this.usesAsync = true; break asyncSearch; }
                }
                if (isExtensionDeclaration(elem)) {
                    for (const method of (elem as ExtensionDeclaration).methods) {
                        if (method.returnType && isAsyncTy(resolveTypeRef(method.returnType))) {
                            this.usesAsync = true; break asyncSearch;
                        }
                        for (const p of method.parameters)
                            if (isAsyncTy(resolveParamType(p))) { this.usesAsync = true; break asyncSearch; }
                    }
                }
            }
        }

        // Scan for generic type instantiations (TypeReference with typeArgs).
        // Must run before funcs generation so genericOpaqueDecls is populated.
        this.collectGenericInstantiations(modules);

        // ── Function bodies ───────────────────────────────────────────────────
        // Generated BEFORE the header so that:
        //   (a) usesStringBuiltins / needsBufferPrintDecl / etc. flags are set
        //       when we assemble the header's runtime-helper section.
        //   (b) strings added during typeInfo/cast intrinsic emission (which
        //       run as part of function codegen) are present in strMap/rawStrMap
        //       when we emit the header's global-constant section.

        const funcs: string[] = [];

        // Emit auto-generated struct constructors (one per struct type)
        // Skipped for types that declare an explicit `static fn new()` — their
        // static method IS the constructor and would collide on the same symbol.
        for (const [typeName] of this.structFieldMap) {
            if (this.structsWithExplicitNew.has(typeName)) continue;
            this.emitStructConstructor(funcs, typeName);
        }

        // ── Emit enum constructors ─────────────────────────────────────────────
        // Non-generic enums
        for (const [enumName, decl] of this.enumDeclMap) {
            if (decl.typeParams?.length > 0) continue; // generic handled below
            this.emitEnumConstructors(funcs, decl, enumName, EMPTY_ENV);
        }
        // Generic enum concrete instantiations
        for (const [baseName, inst] of this.enumInstantiations) {
            this.emitEnumConstructors(funcs, inst.decl, baseName, inst.env);
        }

        // ── Emit @derive(Displayable) toString methods ─────────────────────────
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (!isTypeDeclaration(elem)) continue;
                const td = elem as TypeDeclaration;
                const hasDeriveDisplayable = td.decorators.some(
                    d => d.name === 'derive' && d.args.some(a => a.identVal === 'Displayable')
                );
                if (hasDeriveDisplayable) {
                    this.emitDerivedToStringMethod(funcs, td.name);
                }
            }
        }

        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isFunctionDeclaration(elem)) {
                    const fnDecl = elem as FunctionDeclaration;
                    const hasTypeParams = ((fnDecl as any).typeParams as TypeParam[] | undefined ?? []).length > 0;
                    // Only emit non-generic functions directly; generic ones are emitted on-demand
                    if (!hasTypeParams) {
                        this.emitFunction(funcs, fnDecl, mod.exportedNames);
                    }
                }
            }
        }

        // Emit generic function specializations collected during emitFunction calls
        // (these are queued by emitCallInstr when it sees a generic callee)
        // (they reference this.pendingSpecializations set in emitCallInstrFn)
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isFunctionDeclaration(elem)) {
                    const fnDecl = elem as FunctionDeclaration;
                    const hasTypeParams = ((fnDecl as any).typeParams as TypeParam[] | undefined ?? []).length > 0;
                    if (hasTypeParams) {
                        // Emit any specializations that were queued for this function
                        this.flushPendingSpecializations(funcs, fnDecl, mod.exportedNames);
                    }
                }
            }
        }

        // Emit extension methods (instance and static) — skip generic extensions
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (!isExtensionDeclaration(elem)) continue;
                const extDecl = elem as ExtensionDeclaration;
                const typeDecl = extDecl.typeName?.ref;
                if (!typeDecl) continue;
                // Skip generic extension declarations — they are emitted on-demand
                const extTypeParams: TypeParam[] = (extDecl as any).typeParams ?? [];
                if (extTypeParams.length > 0) continue;
                const selfLlvmTy = resolveTypeDecl(typeDecl);
                for (const method of extDecl.methods) {
                    if (method.static) {
                        this.emitStaticExtensionMethod(funcs, method, typeDecl.name, selfLlvmTy, mod.exportedNames);
                    } else {
                        this.emitExtensionMethod(funcs, method, typeDecl.name, selfLlvmTy, mod.exportedNames);
                    }
                }
                // Emit static properties declared in this extension block
                for (const prop of (extDecl as ExtensionDeclaration).properties ?? []) {
                    this.emitStaticExtensionProperty(funcs, prop, typeDecl.name);
                }
                // Inject protocol default methods for any method the type doesn't override
                if (extDecl.protocol) {
                    // ── instance defaults ──────────────────────────────────────
                    const defaults = this.protocolDefaultsTable.get(extDecl.protocol);
                    if (defaults) {
                        const overriddenNames = new Set(extDecl.methods.filter(m => !m.static).map(m => m.name));
                        for (const [methodName, sig] of defaults) {
                            if (!overriddenNames.has(methodName)) {
                                this.emitProtocolDefaultMethod(funcs, sig, typeDecl.name, selfLlvmTy);
                            }
                        }
                    }
                    // ── static defaults ────────────────────────────────────────
                    const staticDefaults = this.protocolStaticDefaults.get(extDecl.protocol);
                    if (staticDefaults) {
                        const overriddenStaticNames = new Set(extDecl.methods.filter(m => m.static).map(m => m.name));
                        // Fields declared by the protocol (the "known" fields the default body covers)
                        const protoFields = this.protocolFieldNames.get(extDecl.protocol) ?? new Set<string>();
                        // Required fields of the concrete type that are NOT in the protocol field set.
                        // The protocol's default factory body cannot provide values for these.
                        const concreteFields = this.structFieldMap.get(typeDecl.name) ?? [];
                        const hasExtraRequired = concreteFields.some(
                            f => !protoFields.has(f.name) && !f.defaultValue && !f.isFixedArray
                        );
                        for (const [methodName, sig] of staticDefaults) {
                            if (overriddenStaticNames.has(methodName)) continue;
                            // Skip injecting this default factory if the concrete type has
                            // extra required fields that the protocol body doesn't provide.
                            if (hasExtraRequired) continue;
                            this.emitProtocolDefaultStaticMethod(funcs, sig, typeDecl.name, selfLlvmTy);
                        }
                    }
                }
            }
        }

        // Emit struct inline methods (from TypeDeclarations with StructBody)
        for (const [typeName, typeDecl] of this.structTypeDecls) {
            const selfLlvmTy = `%${typeName}*`;
            const body = typeDecl.body as StructBody;
            for (const member of body.members) {
                if (!isStructMethod(member) && !isCallableMethod(member)) continue;
                // Set struct context so Self resolves correctly inside method bodies
                const savedCtx    = this.currentStructContext;
                const savedParent = this.currentParentType;
                this.currentStructContext = typeName;
                this.currentParentType    = this.parentTypeMap.get(typeName) ?? null;
                if (isCallableMethod(member)) {
                    // CallableMethod: implicitly static (no `self` parameter)
                    this.emitStaticExtensionMethod(
                        funcs, member as unknown as ExtensionMethod, typeName, selfLlvmTy, new Set());
                } else {
                    const sm = member as StructMethod;
                    if (sm.static) {
                        // Static struct method — emitted like a static extension method
                        this.emitStaticExtensionMethod(funcs, sm as unknown as ExtensionMethod, typeName, selfLlvmTy, new Set());
                    } else {
                        // Regular instance method — emitted like an extension method
                        this.emitExtensionMethod(funcs, sm as unknown as ExtensionMethod, typeName, selfLlvmTy, new Set());
                    }
                }
                this.currentStructContext = savedCtx;
                this.currentParentType    = savedParent;
            }
        }

        // ── Emit enum inline methods ───────────────────────────────────────────
        // EnumMethods declared inside an enum body are emitted like instance
        // extension methods, with the enum pointer as the implicit `self` parameter.
        for (const [enumName, decl] of this.enumDeclMap) {
            if (decl.typeParams?.length > 0) continue; // generic enums: skip for now
            const selfLlvmTy = `%${enumName}*`;
            for (const member of decl.members) {
                if (!isEnumMethod(member)) continue;
                const em = member as EnumMethod;
                if (em.static) {
                    this.emitStaticExtensionMethod(
                        funcs, em as unknown as ExtensionMethod, enumName, selfLlvmTy, new Set());
                } else {
                    this.emitExtensionMethod(
                        funcs, em as unknown as ExtensionMethod, enumName, selfLlvmTy, new Set());
                }
            }
        }

        // Emit pending generic extension method specializations (queued during body emission).
        // Use a while loop because emitting a spec may queue further specs (nested calls).
        while (this.pendingGenericExtSpecs.size > 0) {
            // Snapshot the pending set so we can iterate while potentially adding more
            const snapshot = new Map(this.pendingGenericExtSpecs);
            this.pendingGenericExtSpecs.clear();
            for (const [mangledName, spec] of snapshot) {
                this.emitGenericExtMethodSpec(funcs, spec.method, spec.selfLlvmTy, spec.typeEnv, mangledName, spec.selfFnParamTypes, spec.selfFnReturnType);
            }
        }

        // Emit pending generic enum inline method specializations.
        while (this.pendingGenericEnumSpecs.size > 0) {
            const snapshot = new Map(this.pendingGenericEnumSpecs);
            this.pendingGenericEnumSpecs.clear();
            for (const [mangledName, spec] of snapshot) {
                this.emitGenericEnumMethodSpec(funcs, spec.method, spec.selfLlvmTy, spec.typeEnv, mangledName);
            }
        }

        if (this.emittedConstFn) {
            funcs.push(`attributes #${CONST_FN_ATTR} = { nounwind readnone speculatable willreturn }`);
            funcs.push('');
        }

        // Flush auto-generated helper functions (struct toString, struct-array toString)
        // emitted lazily when print(ptrArray) is processed for user-defined struct elements.
        if (this.autoGeneratedFunctions.length > 0) {
            funcs.push(...this.autoGeneratedFunctions);
        }

        // Emit deferred lambda function definitions (non-capturing and capturing)
        if (this.lambdaLines.length > 0) {
            funcs.push(...this.lambdaLines);
        }
        // Emit deferred named-function wrapper definitions
        if (this.wrapperLines.length > 0) {
            funcs.push(...this.wrapperLines);
        }

        // ── Assemble the header (globals + declares + struct types) ──────────────
        // Built AFTER `funcs` so all usage flags and string-constant maps are complete.
        const header: string[] = [];

        // Module metadata
        header.push(`; ModuleID = '${this.sourceFile}'`);
        header.push(`source_filename = "${this.sourceFile}"`);
        header.push('');

        // Global string constants  (strMap: printf-style, with \n suffix)
        for (const [, sc] of this.strMap) {
            header.push(`@${sc.globalName} = private unnamed_addr constant [${sc.byteLen} x i8] c"${sc.llvmEncoded}", align 1`);
        }
        // Raw string constants  (rawStrMap: template/concat args, no \n suffix)
        for (const [, sc] of this.rawStrMap) {
            header.push(`@${sc.globalName} = private unnamed_addr constant [${sc.byteLen} x i8] c"${sc.llvmEncoded}", align 1`);
        }
        if (this.strMap.size > 0 || this.rawStrMap.size > 0) header.push('');

        // printf is always needed
        header.push('declare i32 @printf(i8*, ...)');
        header.push('');

        // malloc — needed for closures, struct constructors, and enum constructors.
        // Use a single guard so the declaration is never emitted twice.
        if ((this.usesMalloc || this.structFieldMap.size > 0 || this.enumDeclMap.size > 0 || this.enumInstantiations.size > 0)
                && !this.externTable.has('malloc')) {
            header.push('declare i8* @malloc(i64)');
            header.push('');
        }

        // Env struct type declarations for closures
        if (this.envStructDecls.length > 0) {
            for (const d of this.envStructDecls) header.push(d);
            header.push('');
        }

        // Optional runtime opaque type declarations (only when the type is used)
        if (this.usesNumber) {
            header.push(NUMBER_DECLS);
            header.push('');
        }
        {
            // %Any = type opaque — needed when Any appears in any extern, regular
            // function signature, or is referenced by the cast/typeInfo intrinsics.
            const extVals = [...this.externTable.values()];
            const fnVals  = [...this.fnTable.values()];
            const anyInExterns = extVals.some(e =>
                resolveTypeRef(e.returnType) === ANY_TY
                || e.parameters.some(p => resolveParamType(p) === ANY_TY));
            const anyInFns = fnVals.some(fn =>
                (fn.returnType && resolveTypeRef(fn.returnType) === ANY_TY)
                || fn.parameters.some(p => resolveParamType(p) === ANY_TY));
            if (this.externTable.has('any_get') || this.externTable.has('any_new')
                || anyInExterns || anyInFns) {
                header.push(ANY_DECL);
                header.push('');
            }
            // Reflection opaque types — declared when Field/TypeInfo appear in
            // extern signatures (i.e. stdlib/reflection is imported).
            // FieldArray is no longer a separate opaque type: it is now PtrArray,
            // which is emitted via usesPtrArray below.
            const fieldTY    = FIELD_TY;
            const typeInfoTY = TYPEINFO_TY;
            const usesField = extVals.some(e => resolveTypeRef(e.returnType) === fieldTY
                    || e.parameters.some(p => resolveParamType(p) === fieldTY));
            if (usesField) {
                header.push('%Field = type opaque');
                header.push('');
                // Field lists are now backed by PtrArray — ensure its declarations
                // are included even when no explicit Array<T> variable is present.
                this.usesPtrArray = true;
            }
            if (extVals.some(e => resolveTypeRef(e.returnType) === typeInfoTY
                    || e.parameters.some(p => resolveParamType(p) === typeInfoTY))) {
                header.push('%TypeInfo = type opaque');
                header.push('');
            }
            // FnInfo / ParamInfo — declared when fninfo_* / paraminfo_* externs appear.
            const fnInfoTY    = FNINFO_TY;
            const paramInfoTY = PARAMINFO_TY;
            if (extVals.some(e => resolveTypeRef(e.returnType) === fnInfoTY
                    || e.parameters.some(p => resolveParamType(p) === fnInfoTY))) {
                header.push('%FnInfo = type opaque');
                header.push('');
            }
            if (extVals.some(e => resolveTypeRef(e.returnType) === paramInfoTY
                    || e.parameters.some(p => resolveParamType(p) === paramInfoTY))) {
                header.push('%ParamInfo = type opaque');
                header.push('');
            }
        }
        if (this.usesBuffer) {
            header.push(BUFFER_DECLS);
            header.push('');
        }
        if (this.usesTuiBuffer) {
            header.push(TUIBUFFER_DECL);
            header.push('');
        }
        if (this.usesIntArray) {
            header.push(INTARRAY_DECLS);
            header.push('');
        }
        if (this.usesStringArray) {
            header.push(STRINGARRAY_DECLS);
            header.push('');
        }
        if (this.usesNumberArray) {
            header.push(NUMBERARRAY_DECLS);
            header.push('');
        }
        if (this.usesAnyArray) {
            header.push(ANYARRAY_DECLS);
            header.push('');
        }
        if (this.usesBoolArray) {
            header.push(BOOLARRAY_DECLS);
            header.push('');
        }
        if (this.usesPtrArray) {
            header.push(PTRARRAY_DECLS);
            // Emit runtime function declares for PtrArray built-in methods.
            // These are the non-static functions exposed by runtime/array.c.
            header.push('declare %PtrArray* @ptrarray_new()');
            header.push('declare void @ptrarray_free(%PtrArray*)');
            header.push('declare i32 @ptrarray_length(%PtrArray*)');
            header.push('declare i8* @ptrarray_get(%PtrArray*, i32)');
            header.push('declare void @ptrarray_push(%PtrArray*, i8*)');
            header.push('declare void @ptrarray_set(%PtrArray*, i32, i8*)');
            header.push('');
        }
        if (this.usesIntSet) {
            header.push(INTSET_DECLS);
            header.push('');
        }
        if (this.usesStringSet) {
            header.push(STRINGSET_DECLS);
            header.push('');
        }
        if (this.usesBoolSet) {
            header.push(BOOLSET_DECLS);
            header.push('');
        }
        if (this.usesFloatArray) {
            header.push(FLOATARRAY_DECLS);
            header.push('');
        }
        if (this.usesDoubleArray) {
            header.push(DOUBLEARRAY_DECLS);
            header.push('');
        }
        if (this.usesFloatSet) {
            header.push(FLOATSET_DECLS);
            header.push('');
        }
        if (this.usesDoubleSet) {
            header.push(DOUBLESET_DECLS);
            header.push('');
        }
        if (this.usesNumberSet) {
            header.push(NUMBERSET_DECLS);
            header.push('');
        }
        if (this.usesIntIntMap) {
            header.push(INTINTMAP_DECLS);
            header.push('');
        }
        if (this.usesIntStringMap) {
            header.push(INTSTRINGMAP_DECLS);
            header.push('');
        }
        if (this.usesStringIntMap) {
            header.push(STRINGINTMAP_DECLS);
            header.push('');
        }
        if (this.usesStringStringMap) {
            header.push(STRINGSTRINGMAP_DECLS);
            header.push('');
        }
        if (this.usesIntPtrMap) {
            header.push(INTPTRMAP_DECLS);
            header.push('');
        }
        if (this.usesStringPtrMap) {
            header.push(STRINGPTRMAP_DECLS);
            header.push('');
        }
        if (this.usesPtrIntMap) {
            header.push(PTRINTMAP_DECLS);
            header.push('');
        }
        if (this.usesPtrStrMap) {
            header.push(PTRSTRMAP_DECLS);
            header.push('');
        }
        if (this.usesPtrPtrMap) {
            header.push(PTRPTRMAP_DECLS);
            header.push('');
        }
        if (this.usesMatrix) {
            header.push(MATRIX_DECLS);
            header.push('');
        }
        if (this.usesCoreML) {
            header.push('%CoreMLModel = type opaque');
            header.push('%QuantizedMatrix = type opaque');
            header.push('');
        }
        if (this.usesAsync) {
            header.push(ASYNC_DECLS);
            header.push('');
        }

        // Opaque declarations for generic instantiations (e.g. %Container_i32 = type opaque)
        for (const opaqueDecl of this.genericOpaqueDecls) {
            const baseName = opaqueDecl.replace(/^%/, '').replace(/\*$/, '');
            header.push(`%${baseName} = type opaque`);
            header.push('');
        }

        // Struct type definitions with full field layouts
        for (const [typeName, fields] of this.structFieldMap) {
            const fieldTypes = fields.map(f => toLLVM(f.llvmType)).join(', ');
            header.push(`%${typeName} = type { ${fieldTypes} }`);
            header.push('');
        }

        // ── Enum type definitions ──────────────────────────────────────────────────
        // Before emitting enum struct types, emit `= type opaque` declarations for
        // any intrinsic external struct types referenced in enum variant payloads.
        // e.g. Option<Stacktrace> → %Option_Stacktrace_Some has field %Stacktrace*
        //      → we need `%Stacktrace = type opaque` before that struct def.
        {
            // All type names already defined or to be defined in this file:
            const definedNames = new Set<string>([
                ...this.structFieldMap.keys(),
                ...this.enumDeclMap.keys(),
                ...this.enumInstantiations.keys(),
                'Number', 'Any', 'Buffer',
                'IntArray', 'StringArray', 'PtrArray', 'NumberArray', 'AnyArray',
                'BoolArray', 'FloatArray', 'DoubleArray',
                'IntSet', 'StringSet', 'BoolSet', 'FloatSet', 'DoubleSet', 'NumberSet',
                'Matrix',       // stdlib/npu.code — managed by usesMatrix flag
                'CoreMLModel', 'QuantizedMatrix',  // stdlib/npu/apple_coreml.code — managed by usesCoreML flag
                'Task', 'AsyncContext', 'Shared', 'Scheduler', 'Async', // stdlib/async.code
            ]);
            const neededOpaques = new Set<string>();
            const checkPayloadType = (llvmTy: string): void => {
                // Match `%Foo*` → extract Foo
                const m = llvmTy.match(/^%([A-Za-z_][A-Za-z0-9_]*)\*$/);
                if (m && !definedNames.has(m[1])) neededOpaques.add(m[1]);
            };
            for (const [, decl] of this.enumDeclMap) {
                if (decl.typeParams?.length > 0) continue;
                for (const member of decl.members) {
                    if (!isEnumVariant(member)) continue;
                    for (const p of (member as EnumVariant).payloads ?? [])
                        checkPayloadType(toLLVM(resolveTypeRefWithEnv(p, EMPTY_ENV)));
                }
            }
            for (const [, inst] of this.enumInstantiations) {
                for (const member of inst.decl.members) {
                    if (!isEnumVariant(member)) continue;
                    for (const p of (member as EnumVariant).payloads ?? [])
                        checkPayloadType(toLLVM(resolveTypeRefWithEnv(p, inst.env)));
                }
            }
            if (neededOpaques.size > 0) {
                header.push('; opaque external struct types used in enum variant payloads');
                for (const name of neededOpaques) header.push(`%${name} = type opaque`);
                header.push('');
            }
        }
        // Non-generic enums: emit once using the base name.
        for (const [enumName, decl] of this.enumDeclMap) {
            if (decl.typeParams?.length > 0) continue; // generic enums handled separately
            this.emitEnumTypeDefs(header, enumName, decl, EMPTY_ENV);
        }
        // Generic enum concrete instantiations (e.g. Option<int> → %Option_i32)
        for (const [baseName, inst] of this.enumInstantiations) {
            this.emitEnumTypeDefs(header, baseName, inst.decl, inst.env);
        }

        // Extern function declares (deduplicated across all modules)
        let hasExterns = false;
        const declaredExterns = new Set<string>();
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (!isExternDeclaration(elem)) continue;
                if (declaredExterns.has(elem.name)) continue;
                declaredExterns.add(elem.name);
                if (!hasExterns) { hasExterns = true; }
                const retTy     = toLLVM(resolveTypeRef(elem.returnType));
                const retIsWide = isWideSimdTy(retTy);
                const paramTys  = elem.parameters.map(p => toLLVM(resolveParamType(p)));
                const hasWidePm = paramTys.some(isWideSimdTy);

                if (retIsWide || hasWidePm) {
                    // Wide SIMD (>128-bit) cannot be passed by value on ARM64.
                    // Transform: wide return → first float* out-param (fn returns void),
                    //            wide params → float* (caller alloca + store + bitcast).
                    const retElemTy = retTy.includes('double') ? 'double' : 'float';
                    const wideParams: string[] = [];
                    if (retIsWide) wideParams.push(`${retElemTy}*`);
                    for (const pTy of paramTys) {
                        if (isWideSimdTy(pTy)) {
                            wideParams.push(`${pTy.includes('double') ? 'double' : 'float'}*`);
                        } else {
                            wideParams.push(pTy);
                        }
                    }
                    // Return type: void when original ret was wide (out-param), else keep it.
                    const declRet = retIsWide ? 'void' : (retTy || 'void');
                    header.push(`declare ${declRet} @${elem.name}(${wideParams.join(', ')})`);
                } else {
                    const params = paramTys.join(', ');
                    header.push(`declare ${retTy || 'void'} @${elem.name}(${params})`);
                }
            }
        }
        if (hasExterns) header.push('');

        // ── Inject string built-in declares into header when needed ────────────
        // Built-in string methods (length, at, toString) lower to C runtime calls.
        // runtime/string.c is always linked, but we need `declare` stubs in the IR.
        // Only emit declares for functions NOT already declared via stdlib/string import.
        if (this.usesStringBuiltins) {
            const alreadyDeclared = new Set(this.externTable.keys());
            const needed: Array<[string, string]> = [
                ['length', 'declare i32 @length(i8*)'],
                ['at',     'declare i8* @at(i8*, i32)'],
            ];
            const toAdd = needed.filter(([name]) => !alreadyDeclared.has(name));
            if (toAdd.length > 0) {
                header.push('; string built-in runtime (no stdlib/string import)');
                for (const [, decl] of toAdd) header.push(decl);
                header.push('');
            }
        }

        // ── Inject template-string helper declares ─────────────────────────────
        // int_to_string, float_to_string, and concat are defined in runtime/string.c.
        // We only emit the declares when the functions are actually used, and only
        // when they are not already declared via a stdlib/string extern import.
        {
            const alreadyDeclared = new Set(this.externTable.keys());
            const needed: Array<[string, boolean, string]> = [
                ['int_to_string',    this.usesIntToString,     'declare i8* @int_to_string(i32)'],
                ['int_digit_count',  this.usesIntDigitCount,   'declare i32 @int_digit_count(i32)'],
                ['float_to_string',  this.usesFloatToString,   'declare i8* @float_to_string(double)'],
                ['number_to_string', this.usesNumberToString,  'declare i8* @number_to_string(%Number*)'],
                ['concat',           this.needsConcatDecl,     'declare i8* @concat(i8*, i8*)'],
                ['strcmp',           this.needsStrcmpDecl,     'declare i32 @strcmp(i8*, i8*)'],
                ['buffer_print',         this.needsBufferPrintDecl,    'declare void @buffer_print(%Buffer*)'],
                ['intarray_print',      this.needsIntArrayPrintDecl,    'declare void @intarray_print(%IntArray*)'],
                ['stringarray_print',   this.needsStringArrayPrintDecl, 'declare void @stringarray_print(%StringArray*)'],
                ['numberarray_print',   this.needsNumberArrayPrintDecl, 'declare void @numberarray_print(%NumberArray*)'],
                ['anyarray_print',      this.needsAnyArrayPrintDecl,    'declare void @anyarray_print(%AnyArray*)'],
                ['boolarray_print',     this.needsBoolArrayPrintDecl,   'declare void @boolarray_print(%BoolArray*)'],
                ['intset_print',        this.needsIntSetPrintDecl,      'declare void @intset_print(%IntSet*)'],
                ['stringset_print',     this.needsStringSetPrintDecl,   'declare void @stringset_print(%StringSet*)'],
                ['boolset_print',       this.needsBoolSetPrintDecl,     'declare void @boolset_print(%BoolSet*)'],
                ['floatarray_print',    this.needsFloatArrayPrintDecl,  'declare void @floatarray_print(%FloatArray*)'],
                ['doublearray_print',   this.needsDoubleArrayPrintDecl, 'declare void @doublearray_print(%DoubleArray*)'],
                ['floatset_print',      this.needsFloatSetPrintDecl,    'declare void @floatset_print(%FloatSet*)'],
                ['doubleset_print',     this.needsDoubleSetPrintDecl,   'declare void @doubleset_print(%DoubleSet*)'],
                ['numberset_print',         this.needsNumberSetPrintDecl,       'declare void @numberset_print(%NumberSet*)'],
                ['intintmap_print',         this.needsIntIntMapPrintDecl,       'declare void @intintmap_print(%IntIntMap*)'],
                ['intstringmap_print',      this.needsIntStringMapPrintDecl,    'declare void @intstringmap_print(%IntStringMap*)'],
                ['stringintmap_print',      this.needsStringIntMapPrintDecl,    'declare void @stringintmap_print(%StringIntMap*)'],
                ['stringstringmap_print',   this.needsStringStringMapPrintDecl, 'declare void @stringstringmap_print(%StringStringMap*)'],
                ['intptrmap_print',         this.needsIntPtrMapPrintDecl,       'declare void @intptrmap_print(%IntPtrMap*)'],
                ['stringptrmap_print',      this.needsStringPtrMapPrintDecl,    'declare void @stringptrmap_print(%StringPtrMap*)'],
                ['ptrintmap_print',         this.needsPtrIntMapPrintDecl,       'declare void @ptrintmap_print(%PtrIntMap*)'],
                ['ptrstrmap_print',         this.needsPtrStrMapPrintDecl,       'declare void @ptrstrmap_print(%PtrStringMap*)'],
                ['ptrptrmap_print',         this.needsPtrPtrMapPrintDecl,       'declare void @ptrptrmap_print(%PtrPtrMap*)'],
                // get/put for maps whose stdlib omits the externs (void* bitcast needed)
                ['intptrmap_get',    this.needsIntPtrMapGetDecl,    'declare i8* @intptrmap_get(%IntPtrMap*, i32)'],
                ['intptrmap_put',    this.needsIntPtrMapPutDecl,    'declare void @intptrmap_put(%IntPtrMap*, i32, i8*)'],
                ['stringptrmap_get', this.needsStringPtrMapGetDecl, 'declare i8* @stringptrmap_get(%StringPtrMap*, i8*)'],
                ['stringptrmap_put', this.needsStringPtrMapPutDecl, 'declare void @stringptrmap_put(%StringPtrMap*, i8*, i8*)'],
                ['ptrptrmap_get',    this.needsPtrPtrMapGetDecl,    'declare i8* @ptrptrmap_get(%PtrPtrMap*, i8*)'],
                ['ptrptrmap_put',    this.needsPtrPtrMapPutDecl,    'declare void @ptrptrmap_put(%PtrPtrMap*, i8*, i8*)'],
                ['runtime_panic',           this.needsPanicDecl,                'declare void @runtime_panic(i8*) noreturn'],
                ['fflush',                  this.needsFflushDecl,               'declare i32 @fflush(i8*)'],
                ['codelang_readline',       this.needsReadLineDecl,             'declare i8* @codelang_readline()'],
                ['codelang_readall',        this.needsReadAllDecl,              'declare i8* @codelang_readall()'],
                ['codelang_make_args',      this.needsMakeArgsDecl,             'declare %StringArray* @codelang_make_args(i32, i8**)'],
            ];
            const toAdd = needed.filter(([name, used]) => used && !alreadyDeclared.has(name));
            if (toAdd.length > 0) {
                header.push('; runtime helpers (auto-injected)');
                for (const [, , decl] of toAdd) header.push(decl);
                header.push('');
            }
        }

        return [...header, ...funcs].join('\n');
    }

    // ── Pass 1 ────────────────────────────────────────────────────────────────

    private collectStringsInStmt(stmt: Statement): void {
        if (isPrintStatement(stmt)) {
            this.collectStringsInExpr(stmt.value);
            // Pre-intern printf format strings for non-string print targets
            if (!isStringLiteral(stmt.value)) {
                this.internString('%d');
                this.internString('%ld');
                this.internString('%u');
                this.internString('%lu');
                this.internString('%.15g');
            }
            // Pre-intern %s format — used for ALL i8* print values now.
            this.internString('%s');
        }
        if (isPanicStatement(stmt))                     this.collectStringsInExpr(stmt.value);
        if (isReturnStatement(stmt) && stmt.value)     this.collectStringsInExpr(stmt.value);
        if (isVariableDeclaration(stmt) && stmt.value) this.collectStringsInExpr(stmt.value);
        if (isUsingDeclaration(stmt))                  this.collectStringsInExpr(stmt.value);
        if (isDeferStatement(stmt))                    this.collectStringsInExpr(stmt.target);
        if (isAssignmentStatement(stmt))               this.collectStringsInExpr(stmt.value);
        if (isCompoundAssignStatement(stmt))           this.collectStringsInExpr(stmt.value);
        if (isForStatement(stmt)) {
            if (stmt.init.value) this.collectStringsInExpr(stmt.init.value);
            this.collectStringsInCond(stmt.condition);
            if (stmt.update.value) this.collectStringsInExpr(stmt.update.value);
            for (const s of stmt.body.statements) this.collectStringsInStmt(s);
        }
        if (isCallStatement(stmt)) {
            const cs = stmt as CallStatement;
            for (const a of cs.args) this.collectStringsInCallArg(a);
            // write(s) built-in needs a raw (no-\n) %s format string
            if (cs.callee === 'write') this.rawInternString('%s');
            // flush() built-in needs fflush declared
            if (cs.callee === 'flush') this.needsFflushDecl = true;
        }
        if (isMemberCallStatement(stmt))
            for (const a of (stmt as MemberCallStatement).args) this.collectStringsInCallArg(a);
        if (isMacroCallStatement(stmt)) {
            // Pre-intern strings needed by the built-in macro expansion.
            const mcs = stmt as MacroCallStatement;
            for (const a of mcs.args) this.collectStringsInCallArg(a);
            // assert! / todo! / unreachable! need panic infra
            if (mcs.callee === 'assert' || mcs.callee === 'todo' || mcs.callee === 'unreachable') {
                this.internString('%s'); // for printf in panic path
                this.rawInternString('assertion failed');
                this.rawInternString('not yet implemented');
                this.rawInternString('entered unreachable code');
            }
            // log! needs printf formats and bracket/space strings
            if (mcs.callee === 'log') {
                this.internString('%s');
                this.rawInternString('[');
                this.rawInternString(']');
                this.rawInternString(' ');
            }
        }
        if (isIfStatement(stmt)) {
            this.collectStringsInCond(stmt.condition);
            for (const s of stmt.thenBlock.statements) this.collectStringsInStmt(s);
            if (stmt.elseBlock)
                for (const s of stmt.elseBlock.statements) this.collectStringsInStmt(s);
            if (stmt.elseIf)
                this.collectStringsInStmt(stmt.elseIf);
        }
        if (isWhileStatement(stmt)) {
            this.collectStringsInCond(stmt.condition);
            for (const s of stmt.body.statements) this.collectStringsInStmt(s);
        }
        if (isSwitchStatement(stmt)) {
            const sw = stmt as SwitchStatement;
            this.collectStringsInExpr(sw.subject);
            for (const arm of sw.arms) {
                // Intern string patterns so rawStringGep can resolve them at codegen.
                if (arm.strPat !== undefined) this.rawInternString(arm.strPat);
                for (const s of arm.block.statements) this.collectStringsInStmt(s);
            }
        }
        // Nested function declaration — recurse into its body.
        if (isFunctionDeclaration(stmt)) {
            for (const s of (stmt as FunctionDeclaration).body.statements) {
                this.collectStringsInStmt(s);
            }
        }
    }

    /** Recurse into a Condition tree to pre-intern any string literals it references. */
    private collectStringsInCond(cond: Condition): void {
        if (isBinaryCondition(cond)) {
            this.collectStringsInCond(cond.left);
            this.collectStringsInCond(cond.right);
        } else {
            // BoolExprCondition — expr may contain string literals
            this.collectStringsInExpr((cond as BoolExprCondition).expr);
        }
    }

    private collectStringsInExpr(expr: Expression): void {
        if (isStringLiteral(expr)) {
            // Always intern both forms so emitExpr can use whichever is appropriate.
            this.internString((expr as StringLiteral).value);
            this.rawInternString((expr as StringLiteral).value);
        }
        if (isTemplateLiteral(expr)) {
            // Pre-intern the literal parts of the template string.
            const parts = parseTemplateParts((expr as TemplateLiteral).value);
            for (const p of parts) {
                if (p.kind === 'literal') {
                    this.rawInternString(p.text);
                }
            }
            // Pre-intern "true"/"false" in case any hole evaluates to a bool
            this.rawInternString('true');
            this.rawInternString('false');
        }
        if (isLambdaExpression(expr)) {
            for (const s of (expr as LambdaExpression).body.statements)
                this.collectStringsInStmt(s);
        }
        if (isSelfCallExpression(expr))
            for (const a of (expr as SelfCallExpression).args) this.collectStringsInExpr(a);
        if (isCallExpression(expr))
            for (const a of (expr as CallExpression).args) this.collectStringsInCallArg(a);
        if (isMemberCallExpression(expr))
            for (const a of (expr as MemberCallExpression).args) this.collectStringsInCallArg(a);
        if (isChainedMemberCallExpr(expr))
            for (const a of (expr as ChainedMemberCallExpr).args) this.collectStringsInCallArg(a);
        if (isPostfixCallExpr(expr)) {
            this.collectStringsInExpr((expr as PostfixCallExpr).receiver);
            for (const a of (expr as PostfixCallExpr).args) this.collectStringsInCallArg(a);
        }
        if (isIfExpression(expr)) {
            this.collectStringsInCond((expr as IfExpression).condition);
            this.collectStringsInExpr((expr as IfExpression).thenExpr);
            this.collectStringsInExpr((expr as IfExpression).elseExpr);
        }
        if (isBinaryExpr(expr)) {
            this.collectStringsInExpr((expr as BinaryExpr).left);
            this.collectStringsInExpr((expr as BinaryExpr).right);
        }
        if (isUnaryExpr(expr)) {
            this.collectStringsInExpr((expr as UnaryExpr).operand);
        }
        if (isStructLiteral(expr)) {
            for (const field of (expr as StructLiteral).fields) {
                // field.value is undefined for spread fields (`...src`)
                if (field.value) this.collectStringsInExpr(field.value);
            }
        }
        if (isAnonymousStructLiteral(expr)) {
            for (const field of (expr as AnonymousStructLiteral).fields) {
                if (field.value) this.collectStringsInExpr(field.value);
            }
        }
        if (isArrayLiteral(expr)) {
            for (const el of (expr as ArrayLiteral).elements) this.collectStringsInExpr(el);
        }
        if (isSwitchExpression(expr)) {
            const sw = expr as SwitchExpression;
            this.collectStringsInExpr(sw.subject);
            for (const arm of sw.arms) {
                // Intern string patterns so rawStringGep can resolve them at codegen.
                if (arm.strPat !== undefined) {
                    this.rawInternString(arm.strPat);
                }
                if (arm.expr) this.collectStringsInExpr(arm.expr);
                if (arm.block) {
                    for (const s of arm.block.statements) this.collectStringsInStmt(s);
                }
            }
        }
        // ── Enum constructor: recurse into payload arguments ──────────────────
        // e.g. Result::Err("oops") — "oops" must be pre-interned before codegen.
        if (isEnumConstructor(expr)) {
            for (const arg of (expr as EnumConstructor).args) {
                this.collectStringsInCallArg(arg);
            }
        }
        // ── Macro call expression: recurse into arguments ─────────────────────
        if (isMacroCallExpression(expr)) {
            const mce = expr as MacroCallExpression;
            for (const a of mce.args) this.collectStringsInCallArg(a);
            // dbg! expansion needs "dbg[…] = " prefix strings and %s format
            if (mce.callee === 'dbg') {
                this.internString('%s');
                this.rawInternString(' = ');
                this.rawInternString('dbg[');
                this.rawInternString('] = ');
            }
        }
    }

    /**
     * Collect strings for a function call argument position.
     * String literals are raw-interned (no trailing \n) since they are passed
     * to C functions where strlen must not count an embedded newline.
     * Non-literal sub-expressions are collected normally.
     */
    private collectStringsInCallArg(expr: Expression): void {
        if (isStringLiteral(expr)) {
            // Both intern (for print-format use if needed) and raw-intern (for call args)
            this.internString((expr as StringLiteral).value);
            this.rawInternString((expr as StringLiteral).value);
        } else {
            this.collectStringsInExpr(expr);
        }
    }

    /** Pre-intern raw strings found in return statements (for string-returning extension methods). */
    private collectRawStringsInReturnStmts(stmt: Statement): void {
        if (isReturnStatement(stmt) && stmt.value && isStringLiteral(stmt.value)) {
            this.rawInternString((stmt.value as StringLiteral).value);
        }
        if (isIfStatement(stmt)) {
            for (const s of stmt.thenBlock.statements)  this.collectRawStringsInReturnStmts(s);
            if (stmt.elseBlock)
                for (const s of stmt.elseBlock.statements) this.collectRawStringsInReturnStmts(s);
            if (stmt.elseIf)
                this.collectRawStringsInReturnStmts(stmt.elseIf);
        }
    }

    private internString(inner: string): void {
        if (!this.strMap.has(inner)) {
            const { llvmEncoded, byteLen } = encodeLLVMString(inner);
            this.strMap.set(inner, { globalName: `.str.${this.strIdx++}`, llvmEncoded, byteLen });
        }
    }

    /** Intern a raw string constant (no trailing \n) for use as a function call argument. */
    private rawInternString(inner: string): void {
        if (!this.rawStrMap.has(inner)) {
            const { llvmEncoded, byteLen } = encodeRawLLVMString(inner);
            this.rawStrMap.set(inner, { globalName: `.raw.${this.strIdx++}`, llvmEncoded, byteLen });
        }
    }

    /** Get a getelementptr expression for a raw (no-\n) string constant. */
    private rawStringGep(inner: string): string {
        const sc = this.rawStrMap.get(inner)!;
        return `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
    }

    // ── Struct type collection ────────────────────────────────────────────────
    //
    // Scans all TypeDeclarations with StructBody and populates:
    //   • structFieldMap:  typeName → ordered array of { name, llvmType }
    //   • structTypeDecls: typeName → TypeDeclaration
    //
    // Must be called early in generate() before header emission.

    private collectStructInfo(modules: ResolvedModule[]): void {
        // ── Pre-pass: build name→TypeDecl map and collect protocol names ──────
        const allTypeDecls = new Map<string, TypeDeclaration>();
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isTypeDeclaration(elem))    allTypeDecls.set(elem.name, elem as TypeDeclaration);
                if (isProtocolDeclaration(elem)) {
                    const proto = elem as ProtocolDeclaration;
                    this.protocolSet.add(proto.name);
                    // Record the field names declared in this protocol so we can
                    // later skip injecting static defaults for types with extra fields.
                    const fieldSet = new Set<string>();
                    for (const pf of proto.fields) fieldSet.add(pf.name);
                    this.protocolFieldNames.set(proto.name, fieldSet);
                }
            }
        }

        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (elem.$type !== 'TypeDeclaration') continue;
                const typeDecl = elem as TypeDeclaration;
                if (!isStructBody(typeDecl.body)) continue;
                if (this.structFieldMap.has(typeDecl.name)) continue; // already registered
                const body = typeDecl.body as StructBody;
                const fields: Array<{ name: string; llvmType: string; readonly?: boolean; constType?: boolean; isDisposable?: boolean; isFixedArray?: boolean; arraySize?: number; arrayInitValues?: number[]; defaultValue?: Expression }> = [];

                // ── Handle `type Foo extends Bar { … }` ─────────────────────
                // If this type extends a parent, prepend parent fields before our own.
                //   • Struct parent   → embed parent fields (flat inheritance)
                //   • Intrinsic/alias parent → add implicit `_parent` field
                //   • Protocol parent → no field (protocols have no runtime representation)
                const parentName = (typeDecl as any).parentName as string | undefined;
                if (parentName) {
                    this.parentTypeMap.set(typeDecl.name, parentName);
                    if (this.structFieldMap.has(parentName)) {
                        // Flat struct inheritance: copy parent's fields first
                        for (const pf of this.structFieldMap.get(parentName)!) {
                            fields.push({ ...pf });
                        }
                    } else if (!this.protocolSet.has(parentName)) {
                        // Non-struct, non-protocol parent (intrinsic / alias): _parent field
                        const parentDecl = allTypeDecls.get(parentName);
                        if (parentDecl) {
                            fields.push({
                                name:         '_parent',
                                llvmType:     resolveTypeDecl(parentDecl),
                                readonly:     false,
                                isDisposable: false,
                                isFixedArray: false,
                            });
                        }
                    }
                    // Protocol parent (e.g. Callable, Displayable): no field added
                }

                // ── Detect callable struct (has a CallableMethod named `call`) ─
                for (const member of body.members) {
                    if (isCallableMethod(member) && (member as CallableMethod).name === 'call') {
                        this.callableStructs.add(typeDecl.name);
                        break;
                    }
                    // Also accept `static fn call` StructMethod as callable
                    if (isStructMethod(member) && (member as StructMethod).name === 'call'
                            && (member as StructMethod).static) {
                        this.callableStructs.add(typeDecl.name);
                        break;
                    }
                }

                // ── Validate Callable<[T1,T2,…], R> tuple-arity constraint ────
                // When `type X extends Callable<[T1, T2, …], R>`, the `call`
                // method MUST have exactly as many parameters as the tuple has
                // elements, and their types must match element-by-element.
                // This enforces the conditional-type rule:
                //   A extends Any[] → call(T1, T2, …): R   (n-ary spread)
                //   A extends Any   → call(arg: T):    R   (single-arg)
                if (parentName === 'Callable' && this.callableStructs.has(typeDecl.name)) {
                    const parentTypeArgs = (typeDecl as any).parentTypeArgs as TypeReference[] | undefined;
                    if (parentTypeArgs && parentTypeArgs.length >= 1) {
                        const argTypeRef = parentTypeArgs[0];
                        if (argTypeRef.tupleType) {
                            const tupleArity = argTypeRef.tupleElems?.length ?? 0;
                            const callMember = body.members.find(m =>
                                (isCallableMethod(m) && (m as CallableMethod).name === 'call') ||
                                (isStructMethod(m) && (m as StructMethod).name === 'call' && (m as StructMethod).static),
                            ) as (CallableMethod | StructMethod) | undefined;
                            if (callMember) {
                                const actualArity = callMember.parameters.length;
                                if (actualArity !== tupleArity) {
                                    throw new Error(
                                        `Type '${typeDecl.name}' extends Callable<[…], R> with ` +
                                        `${tupleArity} tuple element(s) but its 'call' method declares ` +
                                        `${actualArity} parameter(s). They must match.`,
                                    );
                                }
                            }
                        }
                    }
                }

                for (const member of body.members) {
                    if (!isFieldDeclaration(member)) continue;
                    const fd = member as FieldDeclaration;
                    const llvmType = resolveTypeRefWithEnv(fd.type, EMPTY_ENV);
                    const isFixedArray = fd.type.elemRef !== undefined && fd.type.arraySize !== undefined;
                    const arraySize   = isFixedArray ? fd.type.arraySize : undefined;

                    // ── Compile-time validation for value-typed arrays ────────
                    // const data: Int[5; 0,1,2,3,4] = [0,1,2,3,4]
                    // typeValues (from the type annotation) must match defaultValue (ArrayLiteral).
                    const typeVals = fd.type.typeValues ?? [];

                    // Extract numeric initializer values from the defaultValue expression.
                    // Legacy `= [v0, v1, ...]` is now parsed as ArrayLiteral via Expression.
                    const initVals: number[] = (() => {
                        if (!fd.defaultValue) return [];
                        if (isArrayLiteral(fd.defaultValue as Expression)) {
                            return (fd.defaultValue as ArrayLiteral).elements
                                .filter(e => isNumberLiteral(e as Expression))
                                .map(e => (e as NumberLiteral).value as number);
                        }
                        return [];
                    })();

                    if (typeVals.length > 0) {
                        if (!fd.readonly) {
                            throw new Error(
                                `Field '${fd.name}' in '${typeDecl.name}': value-typed array (Int[N; ...]) must be declared 'const'`
                            );
                        }
                        if (fd.defaultValue === undefined) {
                            throw new Error(
                                `Field '${fd.name}' in '${typeDecl.name}': value-typed array requires an initializer '= [...]'`
                            );
                        }
                        if (typeVals.length !== initVals.length) {
                            throw new Error(
                                `Field '${fd.name}' in '${typeDecl.name}': type specifies ${typeVals.length} values but initializer has ${initVals.length}`
                            );
                        }
                        for (let vi = 0; vi < typeVals.length; vi++) {
                            if (typeVals[vi] !== initVals[vi]) {
                                throw new Error(
                                    `Field '${fd.name}' in '${typeDecl.name}': value mismatch at index ${vi}: type says ${typeVals[vi]}, initializer says ${initVals[vi]}`
                                );
                            }
                        }
                    }

                    // Determine compile-time array initializer: prefer initVals, fall back to typeValues
                    const arrayInitValues =
                        initVals.length > 0 ? initVals :
                        typeVals.length > 0 ? typeVals :
                        undefined;

                    // Scalar / non-array default value (e.g. `x: int = 0`).
                    // Only stored when it's NOT a fixed-array initializer (those use arrayInitValues).
                    const scalarDefault = (!isFixedArray && fd.defaultValue !== undefined)
                        ? fd.defaultValue as Expression
                        : undefined;

                    fields.push({
                        name:         fd.name,
                        llvmType,
                        readonly:     fd.readonly    || false,
                        // `const Type` qualifier on the field's type annotation
                        constType:    isConstQualifiedTypeRef(fd.type),
                        isDisposable: fd.disposable  || false,
                        isFixedArray,
                        arraySize,
                        arrayInitValues,
                        defaultValue: scalarDefault,
                    });
                }
                this.structFieldMap.set(typeDecl.name, fields);
                this.structTypeDecls.set(typeDecl.name, typeDecl);

                // ── Pre-intern strings from field default values ──────────────
                // Default values like `label: string = "foo"` are emitted during
                // emitStructLiteral; their string constants must exist in strMap.
                for (const f of fields) {
                    if (f.defaultValue) this.collectStringsInExpr(f.defaultValue);
                }

                // ── Collect method metadata for reflection ───────────────────
                const methods: Array<{
                    name:         string;
                    isExportable: boolean;
                    isConst:      boolean;
                    returnType:   string;
                }> = [];
                for (const member of body.members) {
                    if (!isStructMethod(member)) continue;
                    const sm = member as StructMethod;
                    // Track structs that declare an explicit static fn new() — for those,
                    // the auto-generated constructor is suppressed to avoid name collision.
                    if (sm.static && sm.name === 'new') {
                        this.structsWithExplicitNew.add(typeDecl.name);
                    }
                    // Skip static methods from reflection (they are not instance members)
                    if (sm.static) continue;
                    const retLlvm = resolveTypeRef(sm.returnType);
                    methods.push({
                        name:         sm.name,
                        isExportable: sm.export,
                        isConst:      sm.comptime,
                        returnType:   llvmTypeToReadableName(retLlvm),
                    });
                }
                this.structMethodMetaMap.set(typeDecl.name, methods);
            }
        }
    }

    // ── Struct constructor emission ───────────────────────────────────────────
    //
    // Emits a private constructor function `@TypeName_new(field0Ty, field1Ty, ...)`
    // that allocates heap memory via malloc, initialises all fields, and returns
    // a `%TypeName*`.
    //
    // Example for `type Point = { x: int; y: int }`:
    //
    //   define private %Point* @Point_new(i32 %arg.0, i32 %arg.1) {
    //   entry:
    //     %sizeof_ptr = getelementptr %Point, %Point* null, i32 1
    //     %sizeof     = ptrtoint %Point* %sizeof_ptr to i64
    //     %raw        = call i8* @malloc(i64 %sizeof)
    //     %self       = bitcast i8* %raw to %Point*
    //     %f0         = getelementptr inbounds %Point, %Point* %self, i32 0, i32 0
    //     store i32 %arg.0, i32* %f0, align 4
    //     %f1         = getelementptr inbounds %Point, %Point* %self, i32 0, i32 1
    //     store i32 %arg.1, i32* %f1, align 4
    //     ret %Point* %self
    //   }

    private emitStructConstructor(lines: string[], typeName: string): void {
        const fields = this.structFieldMap.get(typeName);
        if (!fields) return;

        const ptrTy  = `%${typeName}*`;
        const baseTy = `%${typeName}`;

        // Fixed-size array fields are initialised inline (not passed as parameters).
        // Build a mapping from field index → parameter index for non-array fields.
        const paramFields = fields.filter(f => !f.isFixedArray);
        const paramList   = paramFields
            .map((f, pi) => `${toLLVM(f.llvmType)} %arg.${pi}`)
            .join(', ');

        lines.push(`; struct constructor for ${typeName}`);
        lines.push(`define private ${ptrTy} @${typeName}_new(${paramList}) {`);
        lines.push('entry:');

        // sizeof trick: GEP from null + 1, ptrtoint gives sizeof(T)
        lines.push(`  %sizeof_ptr = getelementptr ${baseTy}, ${ptrTy} null, i32 1`);
        lines.push(`  %sizeof     = ptrtoint ${ptrTy} %sizeof_ptr to i64`);
        lines.push(`  %raw        = call i8* @malloc(i64 %sizeof)`);
        lines.push(`  %self       = bitcast i8* %raw to ${ptrTy}`);

        let paramIdx = 0;
        for (let i = 0; i < fields.length; i++) {
            const f     = fields[i];
            const irTy  = toLLVM(f.llvmType);
            const fptr  = `%_f${i}`;
            const align = alignOf(f.llvmType);
            lines.push(`  ${fptr} = getelementptr inbounds ${baseTy}, ${ptrTy} %self, i32 0, i32 ${i}`);

            if (f.isFixedArray) {
                // Fixed-size array field: store a constant aggregate value
                const nElems = f.arraySize ?? 0;
                const elemTy = irTy.match(/^\[(\d+) x (.+)\]$/)?.[2] ?? 'i32';
                if (f.arrayInitValues && f.arrayInitValues.length === nElems) {
                    // Initialise from the const-declared values
                    const initVals = f.arrayInitValues.map(v => `${elemTy} ${v}`).join(', ');
                    lines.push(`  store ${irTy} [${initVals}], ${irTy}* ${fptr}, align ${align}`);
                } else {
                    // Zero-initialise
                    lines.push(`  store ${irTy} zeroinitializer, ${irTy}* ${fptr}, align ${align}`);
                }
            } else {
                lines.push(`  store ${irTy} %arg.${paramIdx}, ${irTy}* ${fptr}, align ${align}`);
                paramIdx++;
            }
        }

        lines.push(`  ret ${ptrTy} %self`);
        lines.push('}');
        lines.push('');
    }

    // ── Enum support ──────────────────────────────────────────────────────────────

    /**
     * Populate enumDeclMap and enumVariantTags.
     * Must be called early in generate() so enum types and constructors can be emitted.
     */
    private collectEnumInfo(modules: ResolvedModule[]): void {
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (!isEnumDeclaration(elem)) continue;
                const decl = elem as EnumDeclaration;
                if (this.enumDeclMap.has(decl.name)) continue;
                this.enumDeclMap.set(decl.name, decl);
                const tagMap = new Map<string, number>();
                let nextTag = 0;
                for (const member of decl.members) {
                    if (!isEnumVariant(member)) continue;
                    const v = member as EnumVariant;
                    const tag = v.tag !== undefined ? v.tag : nextTag;
                    nextTag = tag + 1;
                    tagMap.set(v.name, tag);
                }
                this.enumVariantTags.set(decl.name, tagMap);
            }
        }
    }

    /**
     * Emit LLVM `type` declarations for a single enum instantiation.
     *
     * Always emits the base type `%BaseName = type { i32 }` (tag only).
     * For variants with payloads, also emits `%BaseName_Variant = type { i32, T1, ... }`.
     */
    private emitEnumTypeDefs(header: string[], baseName: string, decl: EnumDeclaration, env: TypeEnv): void {
        // Base type: tag only
        header.push(`%${baseName} = type { i32 }`);
        header.push('');
        // Per-variant struct types for variants that carry payloads
        for (const member of decl.members) {
            if (!isEnumVariant(member)) continue;
            const v = member as EnumVariant;
            if (!v.payloads?.length) continue;
            const payloadTypes = v.payloads.map(p => toLLVM(resolveTypeRefWithEnv(p, env))).join(', ');
            header.push(`%${baseName}_${v.name} = type { i32, ${payloadTypes} }`);
            header.push('');
        }
    }

    /**
     * Compute the base struct name for an enum instance.
     * For non-generic enums: just decl.name.
     * For generic enums: mangled name like "Option_i32".
     */
    /**
     * Emit a single enum variant constructor function.
     *
     * For a unit variant (no payloads):
     *   define private %EnumName* @EnumName_Variant() { malloc base struct, store tag, ret }
     *
     * For a payload variant:
     *   define private %EnumName* @EnumName_Variant(T0 %arg.0, ...) {
     *       malloc %EnumName_Variant struct, store tag + payloads, bitcast to base, ret
     *   }
     */
    private emitEnumConstructorFn(
        lines:    string[],
        baseName: string,            // LLVM struct base name (e.g. "Direction" or "Option_i32")
        variant:  EnumVariant,
        tag:      number,
        env:      TypeEnv,
    ): void {
        const ctorName = `${baseName}_${variant.name}`;
        if (this.emittedEnumCtors.has(ctorName)) return;
        this.emittedEnumCtors.add(ctorName);

        const basePtrTy = `%${baseName}*`;
        const baseTy    = `%${baseName}`;

        const payloads = variant.payloads ?? [];
        const payloadTys = payloads.map(p => toLLVM(resolveTypeRefWithEnv(p, env)));

        if (payloads.length === 0) {
            // ── Unit variant ──────────────────────────────────────────────────
            lines.push(`; enum constructor for ${baseName}::${variant.name} (tag=${tag})`);
            lines.push(`define private ${basePtrTy} @${ctorName}() {`);
            lines.push('entry:');
            lines.push(`  %sizeof_ptr = getelementptr ${baseTy}, ${basePtrTy} null, i32 1`);
            lines.push(`  %sizeof     = ptrtoint ${basePtrTy} %sizeof_ptr to i64`);
            lines.push(`  %raw        = call i8* @malloc(i64 %sizeof)`);
            lines.push(`  %self       = bitcast i8* %raw to ${basePtrTy}`);
            lines.push(`  %tagptr     = getelementptr inbounds ${baseTy}, ${basePtrTy} %self, i32 0, i32 0`);
            lines.push(`  store i32 ${tag}, i32* %tagptr, align 4`);
            lines.push(`  ret ${basePtrTy} %self`);
            lines.push('}');
            lines.push('');
        } else {
            // ── Payload variant ───────────────────────────────────────────────
            const variantTy    = `%${baseName}_${variant.name}`;
            const variantPtrTy = `%${baseName}_${variant.name}*`;
            const paramList    = payloadTys.map((t, i) => `${t} %arg.${i}`).join(', ');

            lines.push(`; enum constructor for ${baseName}::${variant.name} (tag=${tag})`);
            lines.push(`define private ${basePtrTy} @${ctorName}(${paramList}) {`);
            lines.push('entry:');
            lines.push(`  %sizeof_ptr = getelementptr ${variantTy}, ${variantPtrTy} null, i32 1`);
            lines.push(`  %sizeof     = ptrtoint ${variantPtrTy} %sizeof_ptr to i64`);
            lines.push(`  %raw        = call i8* @malloc(i64 %sizeof)`);
            lines.push(`  %self       = bitcast i8* %raw to ${variantPtrTy}`);
            lines.push(`  %tagptr     = getelementptr inbounds ${variantTy}, ${variantPtrTy} %self, i32 0, i32 0`);
            lines.push(`  store i32 ${tag}, i32* %tagptr, align 4`);
            for (let i = 0; i < payloadTys.length; i++) {
                const irTy  = payloadTys[i];
                const align = alignOf(irTy);
                lines.push(`  %f${i} = getelementptr inbounds ${variantTy}, ${variantPtrTy} %self, i32 0, i32 ${i + 1}`);
                lines.push(`  store ${irTy} %arg.${i}, ${irTy}* %f${i}, align ${align}`);
            }
            lines.push(`  %base = bitcast ${variantPtrTy} %self to ${basePtrTy}`);
            lines.push(`  ret ${basePtrTy} %base`);
            lines.push('}');
            lines.push('');
        }
        this.usesMalloc = true;
    }

    /**
     * Emit all constructor functions for a single enum (both non-generic and one
     * concrete generic instantiation described by `baseName`/`env`).
     */
    private emitEnumConstructors(lines: string[], decl: EnumDeclaration, baseName: string, env: TypeEnv): void {
        const tagMap = this.enumVariantTags.get(decl.name);
        if (!tagMap) return;
        for (const member of decl.members) {
            if (!isEnumVariant(member)) continue;
            const v   = member as EnumVariant;
            const tag = tagMap.get(v.name) ?? 0;
            this.emitEnumConstructorFn(lines, baseName, v, tag, env);
        }
    }

    /**
     * Emit the expression for an EnumConstructor node.
     *
     * Returns the LLVM register holding the enum value (%EnumName*).
     */
    private emitEnumConstructorExpr(
        lines:   string[],
        ec:      EnumConstructor,
        varCtx:  VarCtx,
        enumTy:  string,          // e.g. "%Direction*" or "%Option_i32*"
    ): string {
        const baseName = enumTy.replace(/^%/, '').replace(/\*$/, ''); // "Direction" or "Option_i32"
        const ctorName = `${baseName}_${ec.variant}`;

        // Determine the decl (handles generic enums by looking up base name)
        const declBaseName = baseName.includes('_')
            ? baseName.split('_')[0]   // "Option" from "Option_i32"
            : baseName;
        const decl = this.enumDeclMap.get(declBaseName) ?? this.enumDeclMap.get(baseName);
        if (!decl) return 'undef';

        // Build env for generic enums
        const envMap = new Map<string, string>();
        const inst = this.enumInstantiations.get(baseName);
        if (inst) {
            for (const [k, v] of inst.env) envMap.set(k, v);
        }
        const env: TypeEnv = envMap;

        // Emit constructor if not already done
        const tagMap = this.enumVariantTags.get(decl.name);
        const variant = decl.members.filter(isEnumVariant).find(m => (m as EnumVariant).name === ec.variant) as EnumVariant | undefined;
        if (variant && tagMap) {
            const tag = tagMap.get(ec.variant) ?? 0;
            this.emitEnumConstructorFn(this.wrapperLines, baseName, variant, tag, env);
        }

        const ptrTy = `%${baseName}*`;
        const payloads = variant?.payloads ?? [];
        const payloadTys = payloads.map(p => toLLVM(resolveTypeRefWithEnv(p, env)));

        if (payloads.length === 0) {
            // Unit variant: just call the constructor
            const reg = `%${this.tmpIdx++}`;
            lines.push(`  ${reg} = call ${ptrTy} @${ctorName}()`);
            return reg;
        }

        // Payload variant: evaluate args and call constructor
        const argRegs: string[] = [];
        for (let i = 0; i < ec.args.length; i++) {
            const argTy  = payloadTys[i] ?? 'i8*';
            const argReg = this.emitExpr(lines, ec.args[i], varCtx, argTy);
            argRegs.push(`${argTy} ${argReg}`);
        }
        const reg = `%${this.tmpIdx++}`;
        lines.push(`  ${reg} = call ${ptrTy} @${ctorName}(${argRegs.join(', ')})`);
        return reg;
    }

    /**
     * Emit LLVM instructions to bind enum payload variables after a successful pattern match.
     *
     * The subject is guaranteed to be a `%EnumName*` pointing to the matched variant.
     * We bitcast to `%EnumName_Variant*` and load each binding into an alloca.
     *
     * Returns a new VarCtx that extends the parent with the new bindings.
     */
    private emitEnumPatternBindings(
        lines:      string[],
        pat:        EnumPattern,
        subjectVal: string,
        varCtx:     VarCtx,
        subjectTy:  string,
    ): VarCtx {
        const newCtx = new Map(varCtx);
        if (!pat.bindings || pat.bindings.length === 0) return newCtx;

        const baseName    = subjectTy.replace(/^%/, '').replace(/\*$/, '');  // "Shape" or "Option_i32"
        const declName    = baseName.includes('_') ? baseName.split('_')[0] : baseName;
        const decl        = this.enumDeclMap.get(declName) ?? this.enumDeclMap.get(baseName);
        if (!decl) return newCtx;

        const variant = decl.members.filter(isEnumVariant)
            .find(m => (m as EnumVariant).name === pat.variant) as EnumVariant | undefined;
        if (!variant || !variant.payloads?.length) return newCtx;

        // Build env for generic enums
        const envMap2 = new Map<string, string>();
        const inst = this.enumInstantiations.get(baseName);
        if (inst) for (const [k, v] of inst.env) envMap2.set(k, v);
        const env: TypeEnv = envMap2;

        const variantTy    = `%${baseName}_${pat.variant}`;
        const variantPtrTy = `%${baseName}_${pat.variant}*`;

        // Bitcast base enum pointer to the specific variant struct pointer
        const castReg = `%${this.tmpIdx++}`;
        lines.push(`  ${castReg} = bitcast %${baseName}* ${subjectVal} to ${variantPtrTy}`);

        for (let i = 0; i < pat.bindings.length; i++) {
            const binding = pat.bindings[i];
            if (binding.wildcard || !binding.name) continue;

            const payloadTy  = variant.payloads[i];
            if (!payloadTy) continue;
            const irTy   = toLLVM(resolveTypeRefWithEnv(payloadTy, env));
            const align  = alignOf(irTy);
            const fieldIdx = i + 1; // field 0 is the tag

            const gepReg  = `%${this.tmpIdx++}`;
            const loadReg = `%${this.tmpIdx++}`;
            // Use a unique numbered register for the alloca so that multiple arms
            // with identically-named bindings (e.g. 'l' and 'r' in Expr::Add and
            // Expr::Mul) do not produce duplicate LLVM value names in the same fn.
            const alloca  = `%${this.tmpIdx++}`;

            lines.push(`  ${gepReg}  = getelementptr inbounds ${variantTy}, ${variantPtrTy} ${castReg}, i32 0, i32 ${fieldIdx}`);
            lines.push(`  ${loadReg} = load ${irTy}, ${irTy}* ${gepReg}, align ${align}`);
            lines.push(`  ${alloca}  = alloca ${irTy}`);
            lines.push(`  store ${irTy} ${loadReg}, ${irTy}* ${alloca}, align ${align}`);

            newCtx.set(binding.name, { llvmType: irTy, allocaName: alloca });
        }

        return newCtx;
    }

    // ── Number usage detection ─────────────────────────────────────────────────

    /** Returns true if any parameter or the return type of fn is Number (%Number*). */
    private fnUsesNumber(fn: FunctionDeclaration): boolean {
        for (const p of fn.parameters)
            if (resolveParamType(p) === NUMBER_TY) return true;
        if (fn.returnType && resolveTypeRef(fn.returnType) === NUMBER_TY) return true;
        return false;
    }

    /**
     * A function is eligible for automatic memoization when:
     *   - It returns %Number*
     *   - It has exactly one parameter that is `const` (immutable) and of type %Number*
     *
     * The compiler guarantees that such a function is pure (deterministic,
     * no observable side-effects on the same input), so caching the result
     * indexed by the argument is always correct.
     */
    private shouldMemoize(fn: FunctionDeclaration): boolean {
        if (fn.name === 'main') return false;
        const retTy = this.resolveReturnType(fn, this.prePassVarCtx(fn));
        if (retTy !== NUMBER_TY) return false;
        if (fn.parameters.length !== 1) return false;
        const p = fn.parameters[0];
        return p.immutable && resolveParamType(p) === NUMBER_TY;
    }

    // ── Function emission ─────────────────────────────────────────────────────

    private emitFunction(
        lines:         string[],
        fn:            FunctionDeclaration,
        exportedNames: Set<string>,
        /** Override the LLVM symbol name — used for nested/local functions. */
        nameOverride?: string,
    ): void {
        const llvmName   = nameOverride ?? fn.name;
        const isMain     = fn.name === 'main' && !nameOverride;
        const isComptime = fn.comptime && !isMain;
        const retTy      = isMain ? 'i32' : this.resolveReturnType(fn, this.prePassVarCtx(fn));
        // `readnone speculatable` is invalid for functions that allocate memory
        // (Number operations call malloc).  Only apply #0 when no Number type is used.
        const pureAttr   = isComptime && !this.fnUsesNumber(fn);
        const attrSuffix = pureAttr ? ` #${CONST_FN_ATTR}` : '';
        if (pureAttr) this.emittedConstFn = true;

        // Resolve type annotation for inferring untyped parameter types
        const fnTypeAnnotation = (fn as any).typeAnnotation as TypeReference | undefined;
        const parentFnRef      = fnTypeAnnotation ? resolveFnTypeRef(fnTypeAnnotation) : null;
        const parentFnParams: any[] = parentFnRef ? (parentFnRef as any).fnParams ?? [] : [];

        // When main takes a string[] (args) or Process parameter, the actual LLVM
        // signature must be `(i32 %argc, i8** %argv)` — the C runtime standard.
        const mainParam0TypeName = isMain && fn.parameters.length > 0
            ? ((fn.parameters[0].type?.ref as any)?.$refText as string | undefined) ?? ''
            : '';
        // fn main(proc: Process)  — single Process parameter
        const isMainWithProcess = isMain && fn.parameters.length === 1
            && mainParam0TypeName === 'Process';
        // fn main(args: string[]) — single array parameter (and NOT Process)
        const isMainWithArgs = isMain && fn.parameters.length > 0 && !isMainWithProcess;
        const paramList = (isMainWithArgs || isMainWithProcess)
            ? 'i32 %argc, i8** %argv'
            : fn.parameters
                .map((p, i) => {
                    let ty: string;
                    if (p.type) {
                        ty = resolveParamType(p);
                    } else if (i < parentFnParams.length && parentFnParams[i]?.type) {
                        ty = resolveTypeRefWithEnv(parentFnParams[i].type as TypeReference, EMPTY_ENV);
                    } else {
                        ty = resolveParamType(p);
                    }
                    return `${toLLVM(ty)} %arg.${i}`;
                })
                .join(', ');

        // Nested functions are always private; top-level functions use normal linkage.
        const linkage = nameOverride
            ? 'private '
            : (isMain || exportedNames.has(fn.name)) ? '' : 'private ';
        const kind = nameOverride                  ? `; local fn (nested inside ${nameOverride.split('.').slice(0, -1).join('.')})`
            : isMain                               ? '; entry point (runtime)'
            : fn.comptime                          ? '; compile-time fn'
            : exportedNames.has(fn.name)           ? '; exported runtime fn'
                                                   : '; runtime fn';
        lines.push(kind);
        lines.push(`define ${linkage}${toLLVM(retTy)} @${llvmName}(${paramList})${attrSuffix} {`);
        lines.push('entry:');

        this.currentFnRetTy         = retTy;
        this.currentFnIsConst       = isComptime;
        this.currentMemoGlobal      = null;
        this.currentMemoParamAlloca = null;
        const savedDefers           = this.currentDefers;
        this.currentDefers          = [];

        const memoize = this.shouldMemoize(fn);
        if (memoize) {
            // Emit the per-function memo-slot global right before the definition
            lines.splice(lines.length - 2, 0,
                `@${llvmName}.memo = global i8* null, align 8`);
        }

        // Save and reset nested-function state for this function's scope.
        const savedFnName       = this.currentFnName;
        const savedLocalScope   = this.localFnScope;
        const savedPendingLocal = this.pendingLocalFns;
        this.currentFnName   = llvmName;
        this.localFnScope    = new Map();
        this.pendingLocalFns = [];

        const varCtx: VarCtx = new Map();

        if (isMainWithArgs) {
            // fn main(args: string[])
            // The LLVM signature is (i32 %argc, i8** %argv).
            // Build a %StringArray* from the C argv array and alloca the param.
            const param = fn.parameters[0];
            const alloca = `%${param.name}`;
            lines.push(`  ${alloca} = alloca %StringArray*, align 8`);
            lines.push(`  %args.raw = call %StringArray* @codelang_make_args(i32 %argc, i8** %argv)`);
            lines.push(`  store %StringArray* %args.raw, %StringArray** ${alloca}, align 8`);
            lines.push('');
            varCtx.set(param.name, { allocaName: alloca, llvmType: '%StringArray*' });
            this.usesStringArray   = true;
            this.needsMakeArgsDecl = true;
        } else if (isMainWithProcess) {
            // fn main(proc: Process)
            // The LLVM signature is (i32 %argc, i8** %argv).
            // Build a heap-allocated %Process struct that bundles args, stdin, stdout.
            //
            //   %Process = type { %StringArray*, %Stdin*, %Stdout* }
            //
            // stdin and stdout have no runtime state (empty structs), so we store
            // null pointers — all method calls on them ignore %self.
            const param    = fn.parameters[0];
            const allocaName = `%${param.name}`;

            // 1. Build args array from C argv
            lines.push(`  %__proc_args = call %StringArray* @codelang_make_args(i32 %argc, i8** %argv)`);

            // 2. Heap-allocate the Process struct
            lines.push(`  %__proc_szptr = getelementptr %Process, %Process* null, i32 1`);
            lines.push(`  %__proc_sz    = ptrtoint %Process* %__proc_szptr to i64`);
            lines.push(`  %__proc_raw   = call i8* @malloc(i64 %__proc_sz)`);
            lines.push(`  %__proc_ptr   = bitcast i8* %__proc_raw to %Process*`);

            // 3. Store args (field 0)
            lines.push(`  %__proc_f0    = getelementptr inbounds %Process, %Process* %__proc_ptr, i32 0, i32 0`);
            lines.push(`  store %StringArray* %__proc_args, %StringArray** %__proc_f0, align 8`);

            // 4. Store stdin (field 1) — null; Stdin has no fields so any pointer works
            lines.push(`  %__proc_f1    = getelementptr inbounds %Process, %Process* %__proc_ptr, i32 0, i32 1`);
            lines.push(`  store %Stdin* null, %Stdin** %__proc_f1, align 8`);

            // 5. Store stdout (field 2) — null; same reasoning
            lines.push(`  %__proc_f2    = getelementptr inbounds %Process, %Process* %__proc_ptr, i32 0, i32 2`);
            lines.push(`  store %Stdout* null, %Stdout** %__proc_f2, align 8`);

            // 6. Alloca for the proc parameter
            lines.push(`  ${allocaName} = alloca %Process*, align 8`);
            lines.push(`  store %Process* %__proc_ptr, %Process** ${allocaName}, align 8`);
            lines.push('');

            varCtx.set(param.name, { allocaName, llvmType: '%Process*' });
            this.usesMalloc        = true;
            this.usesStringArray   = true;
            this.needsMakeArgsDecl = true;
        } else {
            this.allocateParams(lines, fn.parameters, varCtx, fnTypeAnnotation ?? null);
        }

        this.tmpIdx       = 0;
        this.currentLabel = 'entry';

        if (memoize) {
            this.emitMemoPrologue(lines, fn, varCtx);
        }

        const terminated = this.emitStatements(lines, fn.body.statements, varCtx);

        if (!terminated) {
            this.flushDefers(lines, varCtx);
            if (isMain)               lines.push('  ret i32 0');
            else if (retTy === 'void') lines.push('  ret void');
        }

        lines.push('}');
        lines.push('');

        this.currentDefers = savedDefers;

        // Drain pending local functions — emit them right after the outer function.
        const localPending   = this.pendingLocalFns;
        this.currentFnName   = savedFnName;
        this.localFnScope    = savedLocalScope;
        this.pendingLocalFns = savedPendingLocal;

        for (const { fn: localFn, mangledName } of localPending) {
            this.emitFunction(lines, localFn, exportedNames, mangledName);
        }
    }

    private emitExtensionMethod(
        lines:         string[],
        method:        ExtensionMethod,
        typeName:      string,
        selfLlvmTy:    string,
        exportedNames: Set<string>,
    ): void {
        const mangledName = `${typeName}_${method.name}`;

        // Guard: skip if we've already emitted this function definition.
        // This prevents duplicate LLVM function definitions which would cause
        // a clang/llc "redefinition of function" error.
        if (this.emittedExtensionMethods.has(mangledName)) return;
        this.emittedExtensionMethods.add(mangledName);

        // Build a pre-pass varCtx to resolve return type
        const preCtx: VarCtx = new Map();
        preCtx.set('self', { allocaName: '%self', llvmType: selfLlvmTy });
        for (const p of method.parameters)
            preCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: resolveParamType(p) });
        for (const stmt of method.body.statements) {
            if (isVariableDeclaration(stmt)) {
                const ty = this.varDeclType(stmt, preCtx);
                preCtx.set(stmt.name, { allocaName: `%${stmt.name}`, llvmType: ty });
            }
            if (isUsingDeclaration(stmt)) {
                const ty = stmt.varType ? resolveTypeRef(stmt.varType) : this.inferType(stmt.value, preCtx);
                preCtx.set(stmt.name, { allocaName: `%${stmt.name}`, llvmType: ty });
            }
        }

        const retTy = method.returnType
            ? resolveTypeRef(method.returnType)
            : (() => {
                for (const stmt of method.body.statements)
                    if (isReturnStatement(stmt) && stmt.value) return this.inferType(stmt.value, preCtx);
                return 'void';
            })();

        const selfIRTy   = toLLVM(selfLlvmTy);
        const selfParam  = `${selfIRTy} %self.0`;
        const extraParams = method.parameters
            .map((p, i) => `${toLLVM(resolveParamType(p))} %arg.${i}`)
            .join(', ');
        const paramList = extraParams ? `${selfParam}, ${extraParams}` : selfParam;

        const isExported = exportedNames.has(mangledName);
        const linkage    = isExported ? '' : 'private ';

        lines.push(`; extension method ${typeName}.${method.name}`);
        lines.push(`define ${linkage}${toLLVM(retTy)} @${mangledName}(${paramList}) {`);
        lines.push('entry:');

        // Save and reset context
        const savedRetTy        = this.currentFnRetTy;
        const savedIsConst      = this.currentFnIsConst;
        const savedMemoGlobal   = this.currentMemoGlobal;
        const savedMemoAlloca   = this.currentMemoParamAlloca;
        const savedDefers       = this.currentDefers;
        this.currentFnRetTy     = retTy;
        this.currentFnIsConst   = false;
        this.currentMemoGlobal  = null;
        this.currentMemoParamAlloca = null;
        this.currentDefers      = [];

        const varCtx: VarCtx = new Map();

        // Allocate self (implicit first parameter)
        const selfAlign = alignOf(selfLlvmTy);
        lines.push(`  %self = alloca ${selfIRTy}, align ${selfAlign}`);
        lines.push(`  store ${selfIRTy} %self.0, ${ptrOf(selfLlvmTy)} %self, align ${selfAlign}`);
        varCtx.set('self', { allocaName: '%self', llvmType: selfLlvmTy });

        // Allocate explicit parameters
        this.allocateParams(lines, method.parameters, varCtx);

        this.tmpIdx       = 0;
        this.currentLabel = 'entry';

        const terminated = this.emitStatements(lines, method.body.statements, varCtx);

        if (!terminated) {
            this.flushDefers(lines, varCtx);
            if (retTy === 'void') lines.push('  ret void');
        }

        lines.push('}');
        lines.push('');

        // Restore context
        this.currentFnRetTy         = savedRetTy;
        this.currentFnIsConst       = savedIsConst;
        this.currentMemoGlobal      = savedMemoGlobal;
        this.currentMemoParamAlloca = savedMemoAlloca;
        this.currentDefers          = savedDefers;
    }

    // ── Static extension method emission ──────────────────────────────────────
    //
    // Identical to emitExtensionMethod except:
    //   • No implicit `self` parameter or alloca.
    //   • Mangled as `TypeName_methodName` (same convention as instance methods;
    //     there can be no collision since a method can't be both static and instance).

    private emitStaticExtensionMethod(
        lines:         string[],
        method:        ExtensionMethod,
        typeName:      string,
        selfLlvmTy:    string,   // kept for potential future use (e.g., inlining)
        exportedNames: Set<string>,
    ): void {
        const mangledName = `${typeName}_${method.name}`;

        // Guard: skip duplicate emission (same as emitExtensionMethod).
        if (this.emittedExtensionMethods.has(mangledName)) return;
        this.emittedExtensionMethods.add(mangledName);

        // Pre-pass varCtx — no 'self' entry
        const preCtx: VarCtx = new Map();
        for (const p of method.parameters)
            preCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: resolveParamType(p) });
        for (const stmt of method.body.statements) {
            if (isVariableDeclaration(stmt)) {
                const ty = this.varDeclType(stmt, preCtx);
                preCtx.set(stmt.name, { allocaName: `%${stmt.name}`, llvmType: ty });
            }
            if (isUsingDeclaration(stmt)) {
                const ty = stmt.varType ? resolveTypeRef(stmt.varType) : this.inferType(stmt.value, preCtx);
                preCtx.set(stmt.name, { allocaName: `%${stmt.name}`, llvmType: ty });
            }
        }

        const retTy = method.returnType
            ? resolveTypeRef(method.returnType)
            : (() => {
                for (const stmt of method.body.statements)
                    if (isReturnStatement(stmt) && stmt.value) return this.inferType(stmt.value, preCtx);
                return 'void';
            })();

        const paramList = method.parameters
            .map((p, i) => `${toLLVM(resolveParamType(p))} %arg.${i}`)
            .join(', ');

        const isExported = exportedNames.has(mangledName);
        const linkage    = isExported ? '' : 'private ';

        lines.push(`; static extension method ${typeName}.${method.name}`);
        lines.push(`define ${linkage}${toLLVM(retTy)} @${mangledName}(${paramList}) {`);
        lines.push('entry:');

        // Save and reset context
        const savedRetTy    = this.currentFnRetTy;
        const savedIsConst  = this.currentFnIsConst;
        const savedMemoG    = this.currentMemoGlobal;
        const savedMemoA    = this.currentMemoParamAlloca;
        const savedDefers   = this.currentDefers;
        this.currentFnRetTy         = retTy;
        this.currentFnIsConst       = false;
        this.currentMemoGlobal      = null;
        this.currentMemoParamAlloca = null;
        this.currentDefers          = [];

        const varCtx: VarCtx = new Map();
        // No self alloca — that is the defining difference from emitExtensionMethod
        this.allocateParams(lines, method.parameters, varCtx);

        this.tmpIdx       = 0;
        this.currentLabel = 'entry';

        const terminated = this.emitStatements(lines, method.body.statements, varCtx);

        if (!terminated) {
            this.flushDefers(lines, varCtx);
            if (retTy === 'void') lines.push('  ret void');
        }

        lines.push('}');
        lines.push('');

        // Restore context
        this.currentFnRetTy         = savedRetTy;
        this.currentFnIsConst       = savedIsConst;
        this.currentMemoGlobal      = savedMemoG;
        this.currentMemoParamAlloca = savedMemoA;
        this.currentDefers          = savedDefers;
    }

    // ── Static property emission ──────────────────────────────────────────────
    //
    // Each `export static PropName: T = expr;` in an extension block is lowered
    // to a private zero-arg LLVM function `@TypeName_PropName()` that evaluates
    // the initializer expression and returns it.  Accessed as `TypeName.PropName`
    // (no parentheses) at call sites — `emitFieldAccess` emits the call.

    private emitStaticExtensionProperty(
        lines:    string[],
        prop:     ExtensionProperty,
        typeName: string,
    ): void {
        const mangledName = `${typeName}_${prop.name}`;

        // Deduplicate (same guard as extension methods)
        if (this.emittedExtensionMethods.has(mangledName)) return;
        this.emittedExtensionMethods.add(mangledName);

        const retTy = resolveTypeRef(prop.type);
        const llvmRetTy = toLLVM(retTy);

        lines.push(`; static property ${typeName}.${prop.name}`);
        lines.push(`define private ${llvmRetTy} @${mangledName}() {`);
        lines.push('entry:');

        // Save context
        const savedRetTy    = this.currentFnRetTy;
        const savedIsConst  = this.currentFnIsConst;
        const savedMemoG    = this.currentMemoGlobal;
        const savedMemoA    = this.currentMemoParamAlloca;
        const savedDefers   = this.currentDefers;
        this.currentFnRetTy         = retTy;
        this.currentFnIsConst       = true;
        this.currentMemoGlobal      = null;
        this.currentMemoParamAlloca = null;
        this.currentDefers          = [];

        const varCtx: VarCtx = new Map();
        this.tmpIdx       = 0;
        this.currentLabel = 'entry';

        const valReg = this.emitExpr(lines, prop.value, varCtx, retTy);

        this.flushDefers(lines, varCtx);
        lines.push(`  ret ${llvmRetTy} ${valReg}`);
        lines.push('}');
        lines.push('');

        // Restore context
        this.currentFnRetTy         = savedRetTy;
        this.currentFnIsConst       = savedIsConst;
        this.currentMemoGlobal      = savedMemoG;
        this.currentMemoParamAlloca = savedMemoA;
        this.currentDefers          = savedDefers;
    }

    // ── Protocol default method emission ─────────────────────────────────────
    //
    // Emits `@TypeName_methodName(self, ...)` using the default body from the
    // protocol declaration.  Called when a type conforms to a protocol but
    // does not provide its own override for that method.

    private emitProtocolDefaultMethod(
        lines:      string[],
        sig:        MethodSignature,
        typeName:   string,
        selfLlvmTy: string,
    ): void {
        if (!sig.body) return;
        const mangledName = `${typeName}_${sig.name}`;

        // Deduplicate — an explicit extension method already emitted takes priority.
        if (this.emittedExtensionMethods.has(mangledName)) return;
        this.emittedExtensionMethods.add(mangledName);

        // Pre-pass varCtx
        const preCtx: VarCtx = new Map();
        preCtx.set('self', { allocaName: '%self', llvmType: selfLlvmTy });
        for (const p of sig.parameters)
            preCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: resolveParamType(p) });
        for (const stmt of sig.body.statements) {
            if (isVariableDeclaration(stmt)) {
                const ty = this.varDeclType(stmt, preCtx);
                preCtx.set(stmt.name, { allocaName: `%${stmt.name}`, llvmType: ty });
            }
        }

        const retTy = sig.returnType
            ? resolveTypeRef(sig.returnType)
            : (() => {
                for (const stmt of sig.body.statements)
                    if (isReturnStatement(stmt) && stmt.value) return this.inferType(stmt.value, preCtx);
                return 'void';
            })();

        const selfIRTy    = toLLVM(selfLlvmTy);
        const selfParam   = `${selfIRTy} %self.0`;
        const extraParams = sig.parameters
            .map((p, i) => `${toLLVM(resolveParamType(p))} %arg.${i}`)
            .join(', ');
        const paramList = extraParams ? `${selfParam}, ${extraParams}` : selfParam;

        lines.push(`; protocol default ${typeName}.${sig.name}`);
        lines.push(`define private ${toLLVM(retTy)} @${mangledName}(${paramList}) {`);
        lines.push('entry:');

        const savedRetTy    = this.currentFnRetTy;
        const savedIsConst  = this.currentFnIsConst;
        const savedMemoG    = this.currentMemoGlobal;
        const savedMemoA    = this.currentMemoParamAlloca;
        const savedDefers   = this.currentDefers;
        this.currentFnRetTy         = retTy;
        this.currentFnIsConst       = false;
        this.currentMemoGlobal      = null;
        this.currentMemoParamAlloca = null;
        this.currentDefers          = [];

        const varCtx: VarCtx = new Map();
        const selfAlign = alignOf(selfLlvmTy);
        lines.push(`  %self = alloca ${selfIRTy}, align ${selfAlign}`);
        lines.push(`  store ${selfIRTy} %self.0, ${ptrOf(selfLlvmTy)} %self, align ${selfAlign}`);
        varCtx.set('self', { allocaName: '%self', llvmType: selfLlvmTy });
        this.allocateParams(lines, sig.parameters, varCtx);

        this.tmpIdx       = 0;
        this.currentLabel = 'entry';

        const terminated = this.emitStatements(lines, sig.body.statements, varCtx);
        if (!terminated) {
            this.flushDefers(lines, varCtx);
            if (retTy === 'void') lines.push('  ret void');
        }

        lines.push('}');
        lines.push('');

        this.currentFnRetTy         = savedRetTy;
        this.currentFnIsConst       = savedIsConst;
        this.currentMemoGlobal      = savedMemoG;
        this.currentMemoParamAlloca = savedMemoA;
        this.currentDefers          = savedDefers;
    }

    /**
     * Emit a protocol-provided *static* default method for a concrete type.
     *
     * Used when `protocol Error { static fn new(name: string) { … } }` is the
     * only factory and the implementing type (e.g. `NetworkError`) does not
     * provide its own `static fn new`.  In that case we generate:
     *
     *   define private %NetworkError* @NetworkError_new(i8* %arg.0) { … }
     *
     * `Self` inside the body resolves to `typeName` (same as struct static methods).
     */
    private emitProtocolDefaultStaticMethod(
        lines:      string[],
        sig:        MethodSignature,
        typeName:   string,
        selfLlvmTy: string,
    ): void {
        if (!sig.body) return;
        const mangledName = `${typeName}_${sig.name}`;

        // Deduplicate
        if (this.emittedExtensionMethods.has(mangledName)) return;
        this.emittedExtensionMethods.add(mangledName);

        // Pre-pass varCtx — no 'self' entry (static method)
        const preCtx: VarCtx = new Map();
        for (const p of sig.parameters)
            preCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: resolveParamType(p) });
        for (const stmt of sig.body.statements) {
            if (isVariableDeclaration(stmt)) {
                const ty = this.varDeclType(stmt, preCtx);
                preCtx.set(stmt.name, { allocaName: `%${stmt.name}`, llvmType: ty });
            }
        }

        // Type env with Self → selfLlvmTy so `Self` in the return type resolves.
        const selfTypeEnv: Map<string, string> = new Map(this.currentTypeEnv);
        selfTypeEnv.set('Self', selfLlvmTy);

        const retTy = sig.returnType
            ? resolveTypeRefWithEnv(sig.returnType, selfTypeEnv)
            : (() => {
                for (const stmt of sig.body.statements)
                    if (isReturnStatement(stmt) && stmt.value) return this.inferType(stmt.value, preCtx);
                return 'void';
            })();

        const paramList = sig.parameters
            .map((p, i) => `${toLLVM(resolveParamType(p))} %arg.${i}`)
            .join(', ');

        lines.push(`; protocol static default ${typeName}.${sig.name}`);
        lines.push(`define private ${toLLVM(retTy)} @${mangledName}(${paramList}) {`);
        lines.push('entry:');

        const savedRetTy    = this.currentFnRetTy;
        const savedIsConst  = this.currentFnIsConst;
        const savedMemoG    = this.currentMemoGlobal;
        const savedMemoA    = this.currentMemoParamAlloca;
        const savedDefers   = this.currentDefers;
        const savedCtx      = this.currentStructContext;
        const savedParent   = this.currentParentType;
        this.currentFnRetTy         = retTy;
        this.currentFnIsConst       = false;
        this.currentMemoGlobal      = null;
        this.currentMemoParamAlloca = null;
        this.currentDefers          = [];
        // Set Self → typeName so `Self { … }` inside the body creates the right type
        this.currentStructContext   = typeName;
        this.currentParentType      = null;

        const varCtx: VarCtx = new Map();
        this.allocateParams(lines, sig.parameters, varCtx);

        this.tmpIdx       = 0;
        this.currentLabel = 'entry';

        const terminated = this.emitStatements(lines, sig.body.statements, varCtx);
        if (!terminated) {
            this.flushDefers(lines, varCtx);
            if (retTy === 'void') lines.push('  ret void');
        }

        lines.push('}');
        lines.push('');

        this.currentFnRetTy         = savedRetTy;
        this.currentFnIsConst       = savedIsConst;
        this.currentMemoGlobal      = savedMemoG;
        this.currentMemoParamAlloca = savedMemoA;
        this.currentDefers          = savedDefers;
        this.currentStructContext   = savedCtx;
        this.currentParentType      = savedParent;
    }

    // ── Static call-site emission ─────────────────────────────────────────────
    //
    // Called when the parser sees Type.staticMethod(args), e.g. String.new(5).
    // No self argument — arguments are mapped 1-to-1 to method parameters.

    private emitStaticExtensionMethodCall(
        lines:   string[],
        entry:   ExtensionEntry,
        member:  string,
        args:    Expression[],
        varCtx:  VarCtx,
        capture: boolean,
    ): string {
        const mangledName = `${entry.typeName}_${member}`;
        // Build a type env with `Self → selfLlvmTy` so that protocol default
        // methods with return type `Self` resolve correctly (e.g. `static fn new(): Self`).
        const selfEnv = new Map<string, string>(this.currentTypeEnv);
        selfEnv.set('Self', entry.selfLlvmTy);
        const retTy = entry.method.returnType
            ? resolveTypeRefWithEnv(entry.method.returnType, selfEnv)
            : 'void';

        const argStr = entry.method.parameters
            .map((p, i) => {
                const ty     = resolveParamType(p);
                const rawStr = ty === 'i8*';
                let val: string;
                if (i < args.length) {
                    val = this.emitExpr(lines, args[i], varCtx, ty, rawStr);
                } else if (p.defaultValue) {
                    val = this.emitExpr(lines, p.defaultValue, varCtx, ty, rawStr);
                } else {
                    val = 'undef';
                }
                return `${toLLVM(ty)} ${val}`;
            })
            .join(', ');

        if (!retTy || retTy === 'void') {
            lines.push(`  call void @${mangledName}(${argStr})`);
            return '';
        }

        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = call ${toLLVM(retTy)} @${mangledName}(${argStr})`);
        if (!capture) lines.push(`  ; result of @${mangledName} discarded`);
        return result;
    }

    private emitExtensionMethodCall(
        lines:        string[],
        receiverInfo: VarInfo,
        entry:        ExtensionEntry,
        member:       string,
        args:         Expression[],
        varCtx:       VarCtx,
        capture:      boolean,
    ): string {
        const mangledName = `${entry.typeName}_${member}`;
        const retTy    = entry.method.returnType
            ? resolveTypeRef(entry.method.returnType)
            : 'void';
        const selfTy   = receiverInfo.llvmType;
        const selfIRTy = toLLVM(selfTy);

        // Load receiver
        const selfVal = `%${this.tmpIdx++}`;
        lines.push(`  ${selfVal} = load ${selfIRTy}, ${ptrOf(selfTy)} ${receiverInfo.allocaName}, align ${alignOf(selfTy)}`);

        const extraArgStr = entry.method.parameters
            .map((p, i) => {
                const ty  = resolveParamType(p);
                const rawStr = ty === 'i8*';
                let val: string;
                if (i < args.length) {
                    val = this.emitExpr(lines, args[i], varCtx, ty, rawStr);
                } else if (p.defaultValue) {
                    val = this.emitExpr(lines, p.defaultValue, varCtx, ty, rawStr);
                } else {
                    val = 'undef';
                }
                return `${toLLVM(ty)} ${val}`;
            })
            .join(', ');

        const argStr = extraArgStr
            ? `${selfIRTy} ${selfVal}, ${extraArgStr}`
            : `${selfIRTy} ${selfVal}`;

        if (!retTy || retTy === 'void') {
            lines.push(`  call void @${mangledName}(${argStr})`);
            return '';
        }

        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = call ${toLLVM(retTy)} @${mangledName}(${argStr})`);
        if (!capture) lines.push(`  ; result of @${mangledName} discarded`);
        return result;
    }

    /**
     * Emit a call to a generic extension method (one whose declaration has typeParams).
     *
     * The mangled name is derived from the concrete receiver LLVM type, e.g.:
     *   receiver: %Container_i32*  →  Container_i32_id
     *
     * If the specialization hasn't been emitted yet, it is queued in
     * pendingGenericExtSpecs for deferred emission after all regular code.
     */
    private emitGenericExtensionMethodCall(
        lines:              string[],
        receiverInfo:       VarInfo,
        entry:              GenericExtEntry,
        member:             string,
        args:               Expression[],
        varCtx:             VarCtx,
        capture:            boolean,
        typeEnv:            ReadonlyMap<string, string>,
        mangledNameOverride?: string,
    ): string {
        const { method } = entry;
        const selfLlvmTy = receiverInfo.llvmType;
        const typeSuffix = llvmTypeToSuffix(selfLlvmTy);
        const mangledName = mangledNameOverride ?? `${typeSuffix}_${member}`;

        // Queue specialization for deferred emission
        if (!this.emittedSpecializations.has(mangledName)
            && !this.pendingGenericExtSpecs.has(mangledName)) {
            this.pendingGenericExtSpecs.set(mangledName, {
                method,
                selfLlvmTy,
                typeEnv: new Map(typeEnv),
                selfFnParamTypes: receiverInfo.fnParamTypes,
                selfFnReturnType: receiverInfo.fnReturnType,
            });
        }

        const retTy = method.returnType
            ? resolveTypeRefWithEnv(method.returnType, typeEnv)
            : 'void';
        const selfIRTy = toLLVM(selfLlvmTy);

        // Load receiver from its alloca
        const selfVal = `%${this.tmpIdx++}`;
        lines.push(`  ${selfVal} = load ${selfIRTy}, ${ptrOf(selfLlvmTy)} ${receiverInfo.allocaName}, align ${alignOf(selfLlvmTy)}`);

        const extraArgStr = method.parameters
            .map((p, i) => {
                const ty     = resolveTypeRefWithEnv(p.type, typeEnv);
                const rawStr = ty === 'i8*';
                let val: string;
                if (i < args.length) {
                    val = this.emitExpr(lines, args[i], varCtx, ty, rawStr);
                } else if (p.defaultValue) {
                    val = this.emitExpr(lines, p.defaultValue, varCtx, ty, rawStr);
                } else {
                    val = 'undef';
                }
                return `${toLLVM(ty)} ${val}`;
            })
            .join(', ');

        const argStr = extraArgStr
            ? `${selfIRTy} ${selfVal}, ${extraArgStr}`
            : `${selfIRTy} ${selfVal}`;

        if (!retTy || retTy === 'void') {
            lines.push(`  call void @${mangledName}(${argStr})`);
            return '';
        }

        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = call ${toLLVM(retTy)} @${mangledName}(${argStr})`);
        if (!capture) lines.push(`  ; result of @${mangledName} discarded`);
        return result;
    }

    // ── Generic enum inline method call ──────────────────────────────────────────

    /**
     * Emit a call to an inline method of a generic enum (e.g. `opt.isSome()`).
     *
     * This is analogous to `emitGenericExtensionMethodCall` but operates on
     * `EnumMethod` nodes instead of `ExtensionMethod` nodes.
     *
     * The concrete specialization is queued in `pendingGenericEnumSpecs` and emitted
     * after all regular functions, mirroring the generic ext spec flush pattern.
     */
    private emitGenericEnumMethodCall(
        lines:      string[],
        receiverInfo: VarInfo,
        method:     EnumMethod,
        member:     string,
        args:       Expression[],
        varCtx:     VarCtx,
        capture:    boolean,
        typeEnv:    ReadonlyMap<string, string>,
    ): string {
        const selfLlvmTy  = receiverInfo.llvmType;
        const typeSuffix  = llvmTypeToSuffix(selfLlvmTy);
        const mangledName = `${typeSuffix}_${member}`;

        // Queue specialization for deferred emission
        if (!this.emittedEnumMethodSpecs.has(mangledName)
            && !this.pendingGenericEnumSpecs.has(mangledName)) {
            this.pendingGenericEnumSpecs.set(mangledName, {
                method,
                selfLlvmTy,
                typeEnv: new Map(typeEnv),
            });
        }

        const retTy    = method.returnType
            ? resolveTypeRefWithEnv(method.returnType, typeEnv)
            : 'void';
        const selfIRTy = toLLVM(selfLlvmTy);

        // Load receiver from its alloca
        const selfVal = `%${this.tmpIdx++}`;
        lines.push(`  ${selfVal} = load ${selfIRTy}, ${ptrOf(selfLlvmTy)} ${receiverInfo.allocaName}, align ${alignOf(selfLlvmTy)}`);

        const extraArgStr = method.parameters
            .map((p, i) => {
                const ty    = resolveTypeRefWithEnv(p.type, typeEnv);
                const rawStr = ty === 'i8*';
                let val: string;
                if (i < args.length) {
                    val = this.emitExpr(lines, args[i], varCtx, ty, rawStr);
                } else if (p.defaultValue) {
                    val = this.emitExpr(lines, p.defaultValue, varCtx, ty, rawStr);
                } else {
                    val = 'undef';
                }
                return `${toLLVM(ty)} ${val}`;
            })
            .join(', ');

        const argStr = extraArgStr
            ? `${selfIRTy} ${selfVal}, ${extraArgStr}`
            : `${selfIRTy} ${selfVal}`;

        if (!retTy || retTy === 'void') {
            lines.push(`  call void @${mangledName}(${argStr})`);
            return '';
        }

        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = call ${toLLVM(retTy)} @${mangledName}(${argStr})`);
        if (!capture) lines.push(`  ; result of @${mangledName} discarded`);
        return result;
    }

    /**
     * Emit a monomorphized generic enum inline method body.
     * Type parameters in the method signature and body are resolved using `typeEnv`.
     *
     * Example: Option<T>.isSome() specialized with T=i32 → @Option_i32_isSome(%Option_i32* %self.0) -> i1
     */
    private emitGenericEnumMethodSpec(
        lines:      string[],
        method:     EnumMethod,
        selfLlvmTy: string,
        typeEnv:    ReadonlyMap<string, string>,
        mangledName: string,
    ): void {
        if (this.emittedEnumMethodSpecs.has(mangledName)) return;
        this.emittedEnumMethodSpecs.add(mangledName);

        // Resolve return type using concrete typeEnv
        const retTy = method.returnType
            ? resolveTypeRefWithEnv(method.returnType, typeEnv)
            : (() => {
                // Infer from first return statement
                const preCtx: VarCtx = new Map();
                preCtx.set('self', { allocaName: '%self', llvmType: selfLlvmTy });
                for (const p of method.parameters) {
                    preCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: resolveTypeRefWithEnv(p.type, typeEnv) });
                }
                for (const stmt of method.body.statements) {
                    if (isReturnStatement(stmt) && (stmt as ReturnStatement).value)
                        return this.inferType((stmt as ReturnStatement).value!, preCtx);
                }
                return 'void';
            })();

        const selfIRTy   = toLLVM(selfLlvmTy);
        const selfParam  = `${selfIRTy} %self.0`;
        const extraParams = method.parameters
            .map((p, i) => `${toLLVM(resolveTypeRefWithEnv(p.type, typeEnv))} %arg.${i}`)
            .join(', ');
        const paramList = extraParams ? `${selfParam}, ${extraParams}` : selfParam;

        lines.push(`; generic enum method specialization ${mangledName}`);
        lines.push(`define private ${toLLVM(retTy)} @${mangledName}(${paramList}) {`);
        lines.push('entry:');

        // Save and reset context for clean body emission
        const savedRetTy    = this.currentFnRetTy;
        const savedIsConst  = this.currentFnIsConst;
        const savedMemoG    = this.currentMemoGlobal;
        const savedMemoA    = this.currentMemoParamAlloca;
        const savedDefers   = this.currentDefers;
        const savedLabel    = this.currentLabel;
        const savedTmpIdx   = this.tmpIdx;
        const savedTypeEnv  = this.currentTypeEnv;
        const savedLoopStack = this.loopStack;
        this.currentFnRetTy         = retTy;
        this.currentFnIsConst       = false;
        this.currentMemoGlobal      = null;
        this.currentMemoParamAlloca = null;
        this.currentDefers          = [];
        this.currentLabel           = 'entry';
        this.tmpIdx                 = 0;
        this.currentTypeEnv         = typeEnv;
        this.loopStack              = [];

        const varCtx: VarCtx = new Map();

        // Allocate self (implicit first parameter)
        const selfAlign = alignOf(selfLlvmTy);
        lines.push(`  %self = alloca ${selfIRTy}, align ${selfAlign}`);
        lines.push(`  store ${selfIRTy} %self.0, ${ptrOf(selfLlvmTy)} %self, align ${selfAlign}`);
        varCtx.set('self', { allocaName: '%self', llvmType: selfLlvmTy });

        // Allocate explicit parameters using the concrete TypeEnv
        for (let i = 0; i < method.parameters.length; i++) {
            const p     = method.parameters[i];
            const ty    = resolveTypeRefWithEnv(p.type, typeEnv);
            const irTy  = toLLVM(ty);
            const alloca = `%${p.name}`;
            const align  = alignOf(ty);
            lines.push(`  ${alloca} = alloca ${irTy}, align ${align}`);
            lines.push(`  store ${irTy} %arg.${i}, ${ptrOf(ty)} ${alloca}, align ${align}`);
            varCtx.set(p.name, { allocaName: alloca, llvmType: ty });
        }
        if (method.parameters.length > 0) lines.push('');

        const terminated = this.emitStatements(lines, method.body.statements, varCtx);

        if (!terminated) {
            this.flushDefers(lines, varCtx);
            if (retTy === 'void') lines.push('  ret void');
        }

        lines.push('}');
        lines.push('');

        // Restore context
        this.currentFnRetTy         = savedRetTy;
        this.currentFnIsConst       = savedIsConst;
        this.currentMemoGlobal      = savedMemoG;
        this.currentMemoParamAlloca = savedMemoA;
        this.currentDefers          = savedDefers;
        this.currentLabel           = savedLabel;
        this.tmpIdx                 = savedTmpIdx;
        this.currentTypeEnv         = savedTypeEnv;
        this.loopStack              = savedLoopStack;
    }

    /**
     * Emit a monomorphized generic extension method body.
     * Type parameters in the method signature and body are resolved using `typeEnv`.
     *
     * Example: Container<T>.id() specialized with T=i32 → @Container_i32_id(i32* %self.0) -> i32*
     */
    private emitGenericExtMethodSpec(
        lines:            string[],
        method:           ExtensionMethod,
        selfLlvmTy:       string,
        typeEnv:          ReadonlyMap<string, string>,
        mangledName:      string,
        selfFnParamTypes?: string[],
        selfFnReturnType?: string,
    ): void {
        if (this.emittedSpecializations.has(mangledName)) return;
        this.emittedSpecializations.add(mangledName);

        // Resolve the return type in the concrete TypeEnv
        const retTy = method.returnType
            ? resolveTypeRefWithEnv(method.returnType, typeEnv)
            : (() => {
                // Infer from the first return statement
                const preCtx: VarCtx = new Map();
                preCtx.set('self', { allocaName: '%self', llvmType: selfLlvmTy });
                for (const p of method.parameters)
                    preCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: resolveTypeRefWithEnv(p.type, typeEnv) });
                for (const stmt of method.body.statements) {
                    if (isVariableDeclaration(stmt)) {
                        const ty = resolveTypeRefWithEnv((stmt as VariableDeclaration).varType!, typeEnv)
                            ?? this.inferType((stmt as VariableDeclaration).value!, preCtx);
                        preCtx.set((stmt as VariableDeclaration).name, { allocaName: `%${(stmt as VariableDeclaration).name}`, llvmType: ty });
                    }
                    if (isReturnStatement(stmt) && (stmt as ReturnStatement).value)
                        return this.inferType((stmt as ReturnStatement).value!, preCtx);
                }
                return 'void';
            })();

        const selfIRTy   = toLLVM(selfLlvmTy);
        const selfParam  = `${selfIRTy} %self.0`;
        const extraParams = method.parameters
            .map((p, i) => `${toLLVM(resolveTypeRefWithEnv(p.type, typeEnv))} %arg.${i}`)
            .join(', ');
        const paramList = extraParams ? `${selfParam}, ${extraParams}` : selfParam;

        lines.push(`; generic extension specialization ${mangledName}`);
        lines.push(`define private ${toLLVM(retTy)} @${mangledName}(${paramList}) {`);
        lines.push('entry:');

        // Save and reset context for clean body emission
        const savedRetTy    = this.currentFnRetTy;
        const savedIsConst  = this.currentFnIsConst;
        const savedMemoG    = this.currentMemoGlobal;
        const savedMemoA    = this.currentMemoParamAlloca;
        const savedDefers    = this.currentDefers;
        const savedLabel     = this.currentLabel;
        const savedTmpIdx    = this.tmpIdx;
        const savedTypeEnv   = this.currentTypeEnv;
        const savedLoopStack = this.loopStack;
        this.currentFnRetTy         = retTy;
        this.currentFnIsConst       = false;
        this.currentMemoGlobal      = null;
        this.currentMemoParamAlloca = null;
        this.currentDefers          = [];
        this.currentLabel           = 'entry';
        this.tmpIdx                 = 0;
        this.currentTypeEnv         = typeEnv;
        this.loopStack              = [];

        const varCtx: VarCtx = new Map();

        // Allocate self (implicit first parameter)
        const selfAlign = alignOf(selfLlvmTy);
        lines.push(`  %self = alloca ${selfIRTy}, align ${selfAlign}`);
        lines.push(`  store ${selfIRTy} %self.0, ${ptrOf(selfLlvmTy)} %self, align ${selfAlign}`);
        if (isFnValTy(selfLlvmTy)) {
            varCtx.set('self', {
                allocaName:   '%self',
                llvmType:     selfLlvmTy,
                fnParamTypes: selfFnParamTypes,
                fnReturnType: selfFnReturnType,
            });
        } else {
            varCtx.set('self', { allocaName: '%self', llvmType: selfLlvmTy });
        }

        // Allocate explicit parameters using the concrete TypeEnv
        for (let i = 0; i < method.parameters.length; i++) {
            const p     = method.parameters[i];
            const ty    = resolveTypeRefWithEnv(p.type, typeEnv);
            const irTy  = toLLVM(ty);
            const alloca = `%${p.name}`;
            const align = alignOf(ty);
            lines.push(`  ${alloca} = alloca ${irTy}, align ${align}`);
            lines.push(`  store ${irTy} %arg.${i}, ${ptrOf(ty)} ${alloca}, align ${align}`);
            varCtx.set(p.name, { allocaName: alloca, llvmType: ty });
        }
        if (method.parameters.length > 0) lines.push('');

        const terminated = this.emitStatements(lines, method.body.statements, varCtx);

        if (!terminated) {
            this.flushDefers(lines, varCtx);
            if (retTy === 'void') lines.push('  ret void');
        }

        lines.push('}');
        lines.push('');

        // Restore context
        this.currentFnRetTy         = savedRetTy;
        this.currentFnIsConst       = savedIsConst;
        this.currentMemoGlobal      = savedMemoG;
        this.currentMemoParamAlloca = savedMemoA;
        this.currentDefers          = savedDefers;
        this.currentLabel           = savedLabel;
        this.tmpIdx                 = savedTmpIdx;
        this.currentTypeEnv         = savedTypeEnv;
        this.loopStack              = savedLoopStack;
    }

    /**
     * Emit the memoization check prologue for a single-const-Number-param function.
     *
     * Structure added to the entry block (after param allocas):
     *
     *   ; look up argument in the per-function hash table
     *   %memo.key.N  = load %Number*, %Number** %<param>, align 8
     *   %memo.hit.N  = call %Number* @number_memo_get1(i8** @<fn>.memo, %Number* %memo.key.N)
     *   %memo.cond.N = icmp ne %Number* %memo.hit.N, null
     *   br i1 %memo.cond.N, label %memo.return.N, label %memo.miss.N
     *
     * memo.return.N:
     *   ret %Number* %memo.hit.N
     *
     * memo.miss.N:
     *   ; ← user body starts here
     */
    private emitMemoPrologue(lines: string[], fn: FunctionDeclaration, varCtx: VarCtx): void {
        const idx       = this.ifIdx++;
        const missLabel = `memo.miss.${idx}`;
        const retLabel  = `memo.return.${idx}`;
        const param     = fn.parameters[0];
        const pAlloca   = `%${param.name}`;

        const keyReg  = `%${this.tmpIdx++}`;
        const hitReg  = `%${this.tmpIdx++}`;
        const condReg = `%${this.tmpIdx++}`;

        // Use this.currentFnName (already set to the LLVM symbol name, which may
        // be a mangled name for nested functions like "outer.inner").
        const memoGlobal = `${this.currentFnName}.memo`;

        lines.push(`  ${keyReg}  = load %Number*, %Number** ${pAlloca}, align 8`);
        lines.push(`  ${hitReg}  = call %Number* @number_memo_get1(i8** @${memoGlobal}, %Number* ${keyReg})`);
        lines.push(`  ${condReg} = icmp ne %Number* ${hitReg}, null`);
        lines.push(`  br i1 ${condReg}, label %${retLabel}, label %${missLabel}`);
        lines.push('');
        lines.push(`${retLabel}:`);
        lines.push(`  ret %Number* ${hitReg}`);
        lines.push('');
        lines.push(`${missLabel}:`);
        this.currentLabel = missLabel;

        // Record for emitReturn to store results into the table
        this.currentMemoGlobal      = memoGlobal;
        this.currentMemoParamAlloca = pAlloca;
    }

    private allocateParams(
        lines:             string[],
        params:            Parameter[],
        varCtx:            VarCtx,
        parentFnTypeRef?:  TypeReference | null,
    ): void {
        // Resolve parent function type for inferring missing param types
        const parentFnRef    = parentFnTypeRef ? resolveFnTypeRef(parentFnTypeRef) : null;
        const parentFnParams: any[] = parentFnRef ? (parentFnRef as any).fnParams ?? [] : [];

        for (let i = 0; i < params.length; i++) {
            const p = params[i];

            // Resolve type: explicit param type first, then infer from parent annotation
            let ty: string;
            // originalTypeRef: the raw TypeReference for this param (before alias resolution).
            // Kept so that extractFnTypeDetailsFromRef can thread generic type-args through.
            let originalTypeRef: TypeReference | null = null;

            if (p.type) {
                ty = resolveTypeRefWithEnv(p.type, this.currentTypeEnv);
                originalTypeRef = isFnValTy(ty) ? p.type : null;
            } else if (i < parentFnParams.length && parentFnParams[i]?.type) {
                const inferredRef = parentFnParams[i].type as TypeReference;
                ty             = resolveTypeRefWithEnv(inferredRef, this.currentTypeEnv);
                originalTypeRef = isFnValTy(ty) ? inferredRef : null;
            } else {
                ty = resolveParamType(p);
            }

            const irTy  = toLLVM(ty);
            const alloca = `%${p.name}`;
            const align  = alignOf(ty);
            lines.push(`  ${alloca} = alloca ${irTy}, align ${align}`);
            lines.push(`  store ${irTy} %arg.${i}, ${ptrOf(ty)} ${alloca}, align ${align}`);

            if (isFnValTy(ty)) {
                // Use extractFnTypeDetailsFromRef so generic aliases like Function<int,int>
                // correctly resolve their type args via currentTypeEnv.
                const fnDetails = originalTypeRef
                    ? extractFnTypeDetailsFromRef(originalTypeRef, this.currentTypeEnv)
                    : null;
                varCtx.set(p.name, {
                    allocaName:   alloca,
                    llvmType:     ty,
                    fnParamTypes: fnDetails?.paramTypes,
                    fnReturnType: fnDetails?.returnType,
                });
            } else {
                varCtx.set(p.name, { allocaName: alloca, llvmType: ty });
            }
        }
        if (params.length > 0) lines.push('');
    }

    // ── Statement helpers ─────────────────────────────────────────────────────

    /** Emit statements until a terminator.  Returns true if one was hit. */
    private emitStatements(lines: string[], stmts: Statement[], varCtx: VarCtx): boolean {
        // Pre-scan: collect names of all local functions declared in this block.
        // Used by emitCallInstr to detect forward-reference errors.
        const savedBlockLocalFnNames = this.blockLocalFnNames;
        this.blockLocalFnNames = new Set(
            stmts
                .filter(isFunctionDeclaration)
                .map(s => (s as FunctionDeclaration).name)
        );

        let terminated = false;
        for (const stmt of stmts) {
            if (terminated) break;
            terminated = this.emitStatement(lines, stmt, varCtx);
        }

        this.blockLocalFnNames = savedBlockLocalFnNames;
        return terminated;
    }

    /** Emit one statement.  Returns true if it emitted a block terminator. */
    private emitStatement(lines: string[], stmt: Statement, varCtx: VarCtx): boolean {
        if (isVariableDeclaration(stmt))             { this.emitVarDecl(lines, stmt, varCtx); }
        else if (isUsingDeclaration(stmt))           { this.emitUsingDecl(lines, stmt as UsingDeclaration, varCtx); }
        else if (isDeferStatement(stmt))             { this.currentDefers.push({ kind: 'expr', expr: (stmt as DeferStatement).target }); }
        else if (isCompoundAssignStatement(stmt))    { this.emitCompoundAssign(lines, stmt as CompoundAssignStatement, varCtx); }
        else if (isAssignmentStatement(stmt))        { this.emitAssignment(lines, stmt as AssignmentStatement, varCtx); }
        else if (isCallStatement(stmt))              { this.emitCallStatement(lines, stmt as CallStatement, varCtx); }
        else if (isChainedMemberCallStatement(stmt)) { this.emitChainedMemberCall(lines, stmt as ChainedMemberCallStatement, varCtx, false); }
        else if (isMemberCallStatement(stmt))        { this.emitMemberCallStatement(lines, stmt as MemberCallStatement, varCtx); }
        else if (isPrintStatement(stmt))             { this.emitPrint(lines, stmt as PrintStatement, varCtx); }
        else if (isPanicStatement(stmt))    { this.emitPanic(lines, stmt as PanicStatement, varCtx); return true; }
        else if (isReturnStatement(stmt))  { this.emitReturn(lines, stmt as ReturnStatement, varCtx); return true; }
        else if (isBreakStatement(stmt))   { this.emitBreakStatement(lines); return true; }
        else if (isContinueStatement(stmt)){ this.emitContinueStatement(lines); return true; }
        else if (isIfStatement(stmt))       { return this.emitIfStatement(lines, stmt as IfStatement, varCtx); }
        else if (isWhileStatement(stmt))    { this.emitWhileStatement(lines, stmt as WhileStatement, varCtx); }
        else if (isSwitchStatement(stmt))   { return this.emitSwitchStatement(lines, stmt as SwitchStatement, varCtx); }
        else if (isForStatement(stmt))      { this.emitForStatement(lines, stmt as ForStatement, varCtx); }
        else if (isSuperCallStatement(stmt)) {
            // super.method(args); — void super call as a statement
            this.emitSuperCallExpr(lines, stmt as unknown as SuperCallExpression, varCtx, 'void');
        }
        else if (isMacroCallStatement(stmt)) {
            return this.emitMacroCallStatement(lines, stmt as MacroCallStatement, varCtx);
        }
        else if (isFunctionDeclaration(stmt)) {
            // Nested function declaration — register in local scope, defer body emission.
            const fn = stmt as FunctionDeclaration;
            const mangledName = `${this.currentFnName}.${fn.name}`;
            this.localFnScope.set(fn.name, { fn, mangledName });
            this.pendingLocalFns.push({ fn, mangledName });
        }
        return false;
    }

    // ── Variable declaration ──────────────────────────────────────────────────

    private emitVarDecl(lines: string[], decl: VariableDeclaration, varCtx: VarCtx): void {
        // SMI optimisation applied for untyped bindings (see varDeclType).
        const ty    = this.varDeclType(decl, varCtx);
        const irTy  = toLLVM(ty); // real LLVM type for IR emission
        const alloca = `%${decl.name}`, align = alignOf(ty);

        // Alloca lands in the currently-active block (before value evaluation).
        lines.push(`  ${alloca} = alloca ${irTy}, align ${align}`);

        // Track element struct type for PtrArray variables so we can generate
        // correct toString / print IR when print(var) is later encountered.
        if (ty === PTRARRAY_TY && decl.varType) {
            const elemName = this.extractPtrArrayElemName(decl.varType);
            if (elemName) this.ptrArrayElemMap.set(alloca, elemName);
        }

        if (decl.value !== undefined) {
            const val = this.emitExpr(lines, decl.value, varCtx, ty);
            lines.push(`  store ${irTy} ${val}, ${ptrOf(ty)} ${alloca}, align ${align}`);
        }

        // For function-type variables, store fn param/return type info in VarCtx
        if (isFnValTy(ty)) {
            // Use extractFnTypeDetailsFromRef so that generic aliases (e.g. Function<int,int>)
            // correctly thread their type args: fnParamTypes=['i32'], fnReturnType='i32'.
            const fnDetails = extractFnTypeDetailsFromRef(decl.varType, this.currentTypeEnv);
            // When there is no explicit type annotation (fnDetails is null), try to infer
            // fnParamTypes and fnReturnType from the assigned value.  This handles:
            //   const add5 = make_adder(5);  ← make_adder returns fn(int): int
            //   const doubleThenSquare = compose(square, double);  ← generic call
            //   const f    = fn(x: int): int { … };  ← lambda with explicit annotations
            let inferredParamTypes: string[] | undefined = fnDetails?.paramTypes;
            let inferredReturnType: string | undefined   = fnDetails?.returnType;
            if ((!inferredReturnType || !inferredParamTypes) && decl.value) {
                if (isCallExpression(decl.value)) {
                    const callee   = (decl.value as CallExpression).callee;
                    const calleeFn = this.fnTable.get(callee) ?? this.localFnScope.get(callee)?.fn;
                    if (calleeFn?.returnType) {
                        // Build a type env by inferring the generic type params from the
                        // call-site arguments (same logic as inferGenericReturnType).
                        const typeEnv = new Map(this.currentTypeEnv);
                        const callArgs = (decl.value as CallExpression).args ?? [];
                        for (let i = 0; i < calleeFn.parameters.length && i < callArgs.length; i++) {
                            const p  = calleeFn.parameters[i];
                            if (!p.type) continue;
                            const pt = p.type as any;
                            if (pt.ref && !(pt.ref as any).ref) {
                                const pName = pt.ref.$refText as string | undefined;
                                if (pName && !typeEnv.has(pName))
                                    typeEnv.set(pName, this.inferType(callArgs[i], varCtx));
                            } else if (pt.fnType) {
                                this.inferTypeParamsFromFnArg(pt, callArgs[i], varCtx, typeEnv);
                            }
                        }
                        const details = extractFnTypeDetailsFromRef(
                            calleeFn.returnType as unknown as TypeReference,
                            typeEnv,
                        );
                        if (details) {
                            inferredParamTypes ??= details.paramTypes;
                            inferredReturnType ??= details.returnType;
                        }
                    }
                } else if (isLambdaExpression(decl.value)) {
                    const le = decl.value as LambdaExpression;
                    if (le.returnType) {
                        inferredReturnType ??= resolveTypeRef(le.returnType);
                        inferredParamTypes ??= le.parameters.map(p =>
                            p.type ? resolveTypeRef(p.type) : 'i8*',
                        );
                    }
                }
            }
            varCtx.set(decl.name, {
                allocaName:   alloca,
                llvmType:     ty,
                fnParamTypes: inferredParamTypes,
                fnReturnType: inferredReturnType,
            });
        } else {
            varCtx.set(decl.name, { allocaName: alloca, llvmType: ty });
        }
    }

    /**
     * Extract the user-defined struct name from a PtrArray element type annotation.
     *
     * Handles two syntactic forms:
     *   - `Array<User>`  → typeRef.ref → Array decl, typeRef.typeArgs[0].ref → User decl
     *   - `User[]`       → typeRef.elemRef → User decl
     *
     * Returns the struct name (e.g. 'User') or null if the element type is not
     * a user-defined struct.
     */
    private extractPtrArrayElemName(typeRef: TypeReference): string | null {
        // Case 1: Array<User> syntax
        if (typeRef.ref?.ref && typeRef.typeArgs?.length === 1) {
            const mainDecl = typeRef.ref.ref;
            if (mainDecl.name === 'Array') {
                const elemRefDecl = typeRef.typeArgs[0].ref?.ref;
                if (elemRefDecl && isTypeDeclaration(elemRefDecl) && isStructBody(elemRefDecl.body))
                    return elemRefDecl.name;
            }
        }
        // Case 2: User[] shorthand
        if (typeRef.elemRef?.ref) {
            const elemDecl = typeRef.elemRef.ref;
            if (isTypeDeclaration(elemDecl) && isStructBody(elemDecl.body)) return elemDecl.name;
        }
        return null;
    }

    // ── Using declaration ─────────────────────────────────────────────────────
    //
    // `using x: T = expr` is sugar for:
    //   let x: T = expr;
    //   defer x.dispose();   ← synthesised into currentDefers automatically

    private emitUsingDecl(lines: string[], decl: UsingDeclaration, varCtx: VarCtx): void {
        const ty    = decl.varType
            ? resolveTypeRefWithEnv(decl.varType, this.currentTypeEnv)
            : this.inferType(decl.value, varCtx);
        const irTy  = toLLVM(ty);
        const alloca = `%${decl.name}`, align = alignOf(ty);

        lines.push(`  ${alloca} = alloca ${irTy}, align ${align}`);
        const val = this.emitExpr(lines, decl.value, varCtx, ty);
        lines.push(`  store ${irTy} ${val}, ${ptrOf(ty)} ${alloca}, align ${align}`);
        varCtx.set(decl.name, { allocaName: alloca, llvmType: ty });

        // Synthesise defer x.dispose() — will run in LIFO at every return path
        this.currentDefers.push({ kind: 'dispose', varName: decl.name });
    }

    /**
     * V8-style SMI (Small Integer) optimisation:
     *   const x = 42    → i8   (fits in [-128, 127])
     *   const x = 200   → i32  (out of i8 range)
     *   let   x = 42    → i32  (promoted — safe for reassignment)
     *
     * An explicit type annotation always overrides inference.
     * When inside a generic extension method body, `currentTypeEnv` is consulted
     * so that `let v: T = ...` resolves T to the concrete type.
     */
    private varDeclType(decl: VariableDeclaration, ctx: VarCtx): string {
        if (decl.varType) {
            // typeOf(varName) — derive type from an existing variable in the current scope.
            // Usage: const b: typeOf(a) = expr
            const vt = decl.varType as any;
            if (vt.typeOfKw) {
                const varName = vt.typeOfArgId as string;
                const info = ctx.get(varName);
                if (!info) {
                    throw new Error(`typeOf(${varName}): variable '${varName}' is not in scope at this point`);
                }
                return info.llvmType;
            }
            const ty = resolveTypeRefWithEnv(decl.varType, this.currentTypeEnv);
            // Guard against Langium resolving a type annotation to an out-of-graph
            // declaration (e.g. `stdlib/buffer.code`'s `Buffer` when only
            // `stdlib/tui.code` is imported).  If we find an in-graph declaration
            // with the same name, use that instead.
            const resolvedDecl = (decl.varType as any)?.ref?.ref as TypeDeclaration | undefined;
            if (isTypeDeclaration(resolvedDecl)) {
                const graphDecl = this.graphTypeDeclByName.get(resolvedDecl.name);
                if (graphDecl && graphDecl !== resolvedDecl) {
                    return resolveTypeDeclWithArgs(graphDecl, (decl.varType as any)?.typeArgs ?? [], this.currentTypeEnv);
                }
            }
            return ty;
        }
        if (!decl.value)  return 'i8*';
        // SMI: only for immutable `const` with an integer literal
        if (!decl.mutable && isNumberLiteral(decl.value)) {
            const raw = (decl.value as NumberLiteral).value;
            if (Number.isInteger(raw) && !String(raw).includes('.')) {
                if (raw >= -128 && raw <= 127) return 'i8';
                return 'i32';
            }
        }
        return this.inferType(decl.value, ctx);
    }

    // ── PtrArray built-in method dispatch ────────────────────────────────────
    //
    // PtrArray backs `Array<StructType>` and `StructType[]` variables.
    // We handle its methods as IR-level built-ins, emitting direct calls to
    // the non-static ptrarray_* C functions exposed by runtime/array.c.
    //
    // Element coercion:
    //   push(x: %StructTy*)  → bitcast %StructTy* → i8* before calling ptrarray_push
    //   get(i) → i8*         → caller bitcasts i8* → %StructTy* via expectedTy context

    private emitPtrArrayMethod(
        lines:    string[],
        varInfo:  VarInfo,
        member:   string,
        args:     Expression[],
        varCtx:   VarCtx,
        capture:  boolean,
    ): string {
        this.usesPtrArray = true;
        // Load the %PtrArray* from its alloca
        const arrPtr = `%${this.tmpIdx++}`;
        lines.push(`  ${arrPtr} = load %PtrArray*, %PtrArray** ${varInfo.allocaName}, align 8`);

        if (member === 'length') {
            const res = `%${this.tmpIdx++}`;
            lines.push(`  ${res} = call i32 @ptrarray_length(%PtrArray* ${arrPtr})`);
            return capture ? res : 'void';
        }

        if (member === 'push') {
            const argExpr = args[0];
            const argTy   = this.inferType(argExpr, varCtx);
            const argVal  = this.emitExpr(lines, argExpr, varCtx, argTy);
            let castVal = argVal;
            if (argTy.startsWith('<') && argTy.endsWith('>')) {
                // SIMD vector type (<N x float> etc.) — heap-box before storing in PtrArray
                const bytes = simdByteSize(argTy);
                const align = alignOf(argTy);
                const mem = `%${this.tmpIdx++}`;
                lines.push(`  ${mem} = call i8* @malloc(i64 ${bytes})`);
                const ptr = `%${this.tmpIdx++}`;
                lines.push(`  ${ptr} = bitcast i8* ${mem} to ${argTy}*`);
                lines.push(`  store ${argTy} ${argVal}, ${argTy}* ${ptr}, align ${align}`);
                castVal = mem;
            } else if (argTy !== 'i8*') {
                // Struct pointer or any pointer — coerce to i8* (void* in C)
                castVal = `%${this.tmpIdx++}`;
                lines.push(`  ${castVal} = bitcast ${toLLVM(argTy)} ${argVal} to i8*`);
            }
            lines.push(`  call void @ptrarray_push(%PtrArray* ${arrPtr}, i8* ${castVal})`);
            return 'void';
        }

        if (member === 'get') {
            const idxVal = this.emitExpr(lines, args[0], varCtx, 'i32');
            const raw    = `%${this.tmpIdx++}`;
            lines.push(`  ${raw} = call i8* @ptrarray_get(%PtrArray* ${arrPtr}, i32 ${idxVal})`);
            // Return i8* — emitExpr caller will bitcast to expectedTy if needed.
            // For SIMD element types, the caller is responsible for the load.
            return capture ? raw : 'void';
        }

        if (member === 'set') {
            const idxVal  = this.emitExpr(lines, args[0], varCtx, 'i32');
            const argExpr = args[1];
            const argTy   = this.inferType(argExpr, varCtx);
            const argVal  = this.emitExpr(lines, argExpr, varCtx, argTy);
            let castVal = argVal;
            if (argTy.startsWith('<') && argTy.endsWith('>')) {
                // SIMD — heap-box
                const bytes = simdByteSize(argTy);
                const align = alignOf(argTy);
                const mem = `%${this.tmpIdx++}`;
                lines.push(`  ${mem} = call i8* @malloc(i64 ${bytes})`);
                const ptr = `%${this.tmpIdx++}`;
                lines.push(`  ${ptr} = bitcast i8* ${mem} to ${argTy}*`);
                lines.push(`  store ${argTy} ${argVal}, ${argTy}* ${ptr}, align ${align}`);
                castVal = mem;
            } else if (argTy !== 'i8*') {
                castVal = `%${this.tmpIdx++}`;
                lines.push(`  ${castVal} = bitcast ${toLLVM(argTy)} ${argVal} to i8*`);
            }
            lines.push(`  call void @ptrarray_set(%PtrArray* ${arrPtr}, i32 ${idxVal}, i8* ${castVal})`);
            return 'void';
        }

        if (member === 'free') {
            lines.push(`  call void @ptrarray_free(%PtrArray* ${arrPtr})`);
            return 'void';
        }

        lines.push(`  ; WARNING: unknown PtrArray method '${member}'`);
        return 'undef';
    }

    // ── PtrMap method dispatch ────────────────────────────────────────────────
    //
    // Handles method calls on IntPtrMap, StringPtrMap, PtrIntMap, PtrStringMap,
    // and PtrPtrMap.  Keys or values that are user-defined struct pointers must
    // be bitcast to/from i8* (void*) before/after the C runtime call.

    private static readonly PTRMAP_INFO: Record<string, {
        prefix: string;
        keyIRTy: string;
        valIRTy: string;
        needsKeyBitcast: boolean;
        needsValBitcast: boolean;
    }> = {
        '%IntPtrMap*':    { prefix: 'intptrmap_',    keyIRTy: 'i32',  valIRTy: 'i8*', needsKeyBitcast: false, needsValBitcast: true  },
        '%StringPtrMap*': { prefix: 'stringptrmap_', keyIRTy: 'i8*',  valIRTy: 'i8*', needsKeyBitcast: false, needsValBitcast: true  },
        '%PtrIntMap*':    { prefix: 'ptrintmap_',    keyIRTy: 'i8*',  valIRTy: 'i32', needsKeyBitcast: true,  needsValBitcast: false },
        '%PtrStringMap*': { prefix: 'ptrstrmap_',    keyIRTy: 'i8*',  valIRTy: 'i8*', needsKeyBitcast: true,  needsValBitcast: false },
        '%PtrPtrMap*':    { prefix: 'ptrptrmap_',    keyIRTy: 'i8*',  valIRTy: 'i8*', needsKeyBitcast: true,  needsValBitcast: true  },
    };

    private emitPtrMapMethod(
        lines:   string[],
        varInfo: VarInfo,
        member:  string,
        args:    Expression[],
        varCtx:  VarCtx,
        capture: boolean,
    ): string {
        const mapTy = varInfo.llvmType;  // e.g. '%IntPtrMap*'
        const info  = GeneratorContext.PTRMAP_INFO[mapTy];
        if (!info) {
            lines.push(`  ; WARNING: unknown PtrMap type '${mapTy}'`);
            return 'undef';
        }
        const { prefix, keyIRTy, valIRTy, needsKeyBitcast, needsValBitcast } = info;

        // Load the map pointer from its alloca
        const baseTy  = mapTy.slice(0, -1);      // strip trailing '*'  → '%IntPtrMap'
        const mapPtr  = `%${this.tmpIdx++}`;
        lines.push(`  ${mapPtr} = load ${mapTy}, ${mapTy}* ${varInfo.allocaName}, align 8`);

        if (member === 'size' || member === 'length') {
            const res = `%${this.tmpIdx++}`;
            lines.push(`  ${res} = call i32 @${prefix}size(${baseTy}* ${mapPtr})`);
            return capture ? res : 'void';
        }

        if (member === 'free') {
            lines.push(`  call void @${prefix}free(${baseTy}* ${mapPtr})`);
            return 'void';
        }

        if (member === 'contains') {
            let keyVal = this.emitExpr(lines, args[0], varCtx, keyIRTy);
            if (needsKeyBitcast) {
                const keyArgTy = this.inferType(args[0], varCtx);
                if (keyArgTy !== 'i8*') {
                    const cast = `%${this.tmpIdx++}`;
                    lines.push(`  ${cast} = bitcast ${keyArgTy} ${keyVal} to i8*`);
                    keyVal = cast;
                }
            }
            const raw = `%${this.tmpIdx++}`;
            lines.push(`  ${raw} = call i32 @${prefix}contains(${baseTy}* ${mapPtr}, ${keyIRTy} ${keyVal})`);
            const boolRes = `%${this.tmpIdx++}`;
            lines.push(`  ${boolRes} = icmp ne i32 ${raw}, 0`);
            return capture ? boolRes : 'void';
        }

        if (member === 'remove') {
            let keyVal = this.emitExpr(lines, args[0], varCtx, keyIRTy);
            if (needsKeyBitcast) {
                const keyArgTy = this.inferType(args[0], varCtx);
                if (keyArgTy !== 'i8*') {
                    const cast = `%${this.tmpIdx++}`;
                    lines.push(`  ${cast} = bitcast ${keyArgTy} ${keyVal} to i8*`);
                    keyVal = cast;
                }
            }
            lines.push(`  call void @${prefix}remove(${baseTy}* ${mapPtr}, ${keyIRTy} ${keyVal})`);
            return 'void';
        }

        if (member === 'get') {
            // Auto-inject declare stubs for get/put functions omitted from stdlib externs
            if (!this.externTable.has(`${prefix}get`)) {
                if (mapTy === INTPTRMAP_TY)    this.needsIntPtrMapGetDecl    = true;
                if (mapTy === STRINGPTRMAP_TY) this.needsStringPtrMapGetDecl = true;
                if (mapTy === PTRPTRMAP_TY)    this.needsPtrPtrMapGetDecl    = true;
            }
            let keyVal = this.emitExpr(lines, args[0], varCtx, keyIRTy);
            if (needsKeyBitcast) {
                const keyArgTy = this.inferType(args[0], varCtx);
                if (keyArgTy !== 'i8*') {
                    const cast = `%${this.tmpIdx++}`;
                    lines.push(`  ${cast} = bitcast ${keyArgTy} ${keyVal} to i8*`);
                    keyVal = cast;
                }
            }
            const raw = `%${this.tmpIdx++}`;
            lines.push(`  ${raw} = call ${valIRTy} @${prefix}get(${baseTy}* ${mapPtr}, ${keyIRTy} ${keyVal})`);
            // Return the raw value; caller will bitcast to expectedTy when needed.
            return capture ? raw : 'void';
        }

        if (member === 'put') {
            // Auto-inject declare stubs for get/put functions omitted from stdlib externs
            if (!this.externTable.has(`${prefix}put`)) {
                if (mapTy === INTPTRMAP_TY)    this.needsIntPtrMapPutDecl    = true;
                if (mapTy === STRINGPTRMAP_TY) this.needsStringPtrMapPutDecl = true;
                if (mapTy === PTRPTRMAP_TY)    this.needsPtrPtrMapPutDecl    = true;
            }
            let keyVal = this.emitExpr(lines, args[0], varCtx, keyIRTy);
            if (needsKeyBitcast) {
                const keyArgTy = this.inferType(args[0], varCtx);
                if (keyArgTy !== 'i8*') {
                    const cast = `%${this.tmpIdx++}`;
                    lines.push(`  ${cast} = bitcast ${keyArgTy} ${keyVal} to i8*`);
                    keyVal = cast;
                }
            }
            let valVal = this.emitExpr(lines, args[1], varCtx, valIRTy);
            if (needsValBitcast) {
                const valArgTy = this.inferType(args[1], varCtx);
                if (valArgTy !== 'i8*') {
                    const cast = `%${this.tmpIdx++}`;
                    lines.push(`  ${cast} = bitcast ${valArgTy} ${valVal} to i8*`);
                    valVal = cast;
                }
            }
            lines.push(`  call void @${prefix}put(${baseTy}* ${mapPtr}, ${keyIRTy} ${keyVal}, ${valIRTy} ${valVal})`);
            return 'void';
        }

        lines.push(`  ; WARNING: unknown PtrMap method '${member}' on ${mapTy}`);
        return 'undef';
    }

    // ── Auto-generated struct toString / PtrArray toString ────────────────────
    //
    // When the user calls print(users) where users: Array<StructType>, the IR
    // generator lazily emits:
    //   @StructName_autoToString(%StructName* %ptr) → i8*
    //   @StructName_PtrArray_toString(%PtrArray* %arr) → i8*
    //
    // These are internal functions added to autoGeneratedFunctions[], which is
    // flushed into the funcs section after all regular functions.

    private emitAutoStructToStringFn(structName: string): void {
        const fields = this.structFieldMap.get(structName);
        if (!fields || fields.length === 0) return;

        // Ensure concat and int_to_string declares are emitted
        this.needsConcatDecl = true;

        // Pre-intern all string constants we'll need
        this.rawInternString('{');
        this.rawInternString('}');
        for (let fi = 0; fi < fields.length; fi++) {
            const f = fields[fi];
            const fIrTy = toLLVM(f.llvmType);
            if (fi === 0) {
                if (fIrTy === 'i8*') this.rawInternString(`${f.name}: "`);
                else                  this.rawInternString(`${f.name}: `);
            } else {
                if (fIrTy === 'i8*') this.rawInternString(`, ${f.name}: "`);
                else                  this.rawInternString(`, ${f.name}: `);
            }
            if (fIrTy === 'i8*') this.rawInternString('"');
        }

        const lines: string[] = [];
        lines.push(`define internal i8* @${structName}_autoToString(%${structName}* %ptr) {`);
        lines.push('entry:');

        let curStr: string;

        // Start with "{"
        curStr = this.rawStringGep('{');

        for (let fi = 0; fi < fields.length; fi++) {
            const f = fields[fi];
            const fIrTy = toLLVM(f.llvmType);

            // Determine prefix (field name + separator + opening quote for strings)
            let prefix: string;
            let hasSuffix = false;
            if (fi === 0) {
                prefix = fIrTy === 'i8*' ? `${f.name}: "` : `${f.name}: `;
                hasSuffix = fIrTy === 'i8*';
            } else {
                prefix = fIrTy === 'i8*' ? `, ${f.name}: "` : `, ${f.name}: `;
                hasSuffix = fIrTy === 'i8*';
            }
            const prefixGep = this.rawStringGep(prefix);

            // concat(curStr, prefix)
            const tmp1 = `%asg${this.tmpIdx++}`;
            lines.push(`  ${tmp1} = call i8* @concat(i8* ${curStr}, i8* ${prefixGep})`);
            curStr = tmp1;

            // Load the field from the struct
            const fptr = `%asg${this.tmpIdx++}`;
            lines.push(`  ${fptr} = getelementptr inbounds %${structName}, %${structName}* %ptr, i32 0, i32 ${fi}`);
            const fval = `%asg${this.tmpIdx++}`;
            lines.push(`  ${fval} = load ${fIrTy}, ${fIrTy}* ${fptr}, align ${alignOf(f.llvmType)}`);

            // Convert field value to string
            let fieldStr: string;
            if (fIrTy === 'i8*') {
                fieldStr = fval;
            } else if (fIrTy === 'i32') {
                this.usesIntToString = true;
                fieldStr = `%asg${this.tmpIdx++}`;
                lines.push(`  ${fieldStr} = call i8* @int_to_string(i32 ${fval})`);
            } else if (fIrTy === 'i8' || fIrTy === 'i16') {
                this.usesIntToString = true;
                const ext = `%asg${this.tmpIdx++}`;
                lines.push(`  ${ext} = sext ${fIrTy} ${fval} to i32`);
                fieldStr = `%asg${this.tmpIdx++}`;
                lines.push(`  ${fieldStr} = call i8* @int_to_string(i32 ${ext})`);
            } else if (fIrTy === 'i1') {
                // Bool: use pre-interned "true"/"false"
                this.rawInternString('true');
                this.rawInternString('false');
                const tGep = this.rawStringGep('true');
                const fGep = this.rawStringGep('false');
                fieldStr = `%asg${this.tmpIdx++}`;
                lines.push(`  ${fieldStr} = select i1 ${fval}, i8* ${tGep}, i8* ${fGep}`);
            } else {
                // Fallback for unsupported types
                this.rawInternString('<?>');
                fieldStr = this.rawStringGep('<?>');
            }

            // concat(curStr, fieldStr)
            const tmp2 = `%asg${this.tmpIdx++}`;
            lines.push(`  ${tmp2} = call i8* @concat(i8* ${curStr}, i8* ${fieldStr})`);
            curStr = tmp2;

            // Add closing quote for string fields
            if (hasSuffix) {
                const tmp3 = `%asg${this.tmpIdx++}`;
                lines.push(`  ${tmp3} = call i8* @concat(i8* ${curStr}, i8* ${this.rawStringGep('"')})`);
                curStr = tmp3;
            }
        }

        // Close with "}"
        const finalRes = `%asg${this.tmpIdx++}`;
        lines.push(`  ${finalRes} = call i8* @concat(i8* ${curStr}, i8* ${this.rawStringGep('}')})`);
        lines.push(`  ret i8* ${finalRes}`);
        lines.push('}');
        lines.push('');
        this.autoGeneratedFunctions.push(lines.join('\n'));
    }

    private emitAutoStructPtrArrayToStringFn(structName: string): void {
        // Pre-intern strings
        this.rawInternString('[]');
        this.rawInternString('[');
        this.rawInternString(']');
        this.rawInternString(', ');
        this.needsConcatDecl = true;
        this.usesPtrArray    = true;

        const fnName = `${structName}_PtrArray_toString`;
        const ifIdx  = this.ifIdx++;  // unique index for labels

        const lines: string[] = [];
        lines.push(`define internal i8* @${fnName}(%PtrArray* %arr) {`);
        lines.push(`ptsentry_${ifIdx}:`);

        // Get length
        const lenReg = `%ptlen_${ifIdx}`;
        lines.push(`  ${lenReg} = call i32 @ptrarray_length(%PtrArray* %arr)`);
        const isZeroReg = `%ptiz_${ifIdx}`;
        lines.push(`  ${isZeroReg} = icmp eq i32 ${lenReg}, 0`);
        lines.push(`  br i1 ${isZeroReg}, label %ptempty_${ifIdx}, label %ptstart_${ifIdx}`);
        lines.push('');

        // Empty case
        lines.push(`ptempty_${ifIdx}:`);
        const emptyGep = this.rawStringGep('[]');
        lines.push(`  ret i8* ${emptyGep}`);
        lines.push('');

        // Loop start
        lines.push(`ptstart_${ifIdx}:`);
        const openGep = this.rawStringGep('[');
        lines.push(`  br label %pthead_${ifIdx}`);
        lines.push('');

        // Loop head (phi nodes)
        lines.push(`pthead_${ifIdx}:`);
        const iReg   = `%pti_${ifIdx}`;
        const accReg = `%ptacc_${ifIdx}`;
        lines.push(`  ${iReg} = phi i32 [ 0, %ptstart_${ifIdx} ], [ %ptinext_${ifIdx}, %ptbody_end_${ifIdx} ]`);
        lines.push(`  ${accReg} = phi i8* [ ${openGep}, %ptstart_${ifIdx} ], [ %ptacc_new_${ifIdx}, %ptbody_end_${ifIdx} ]`);
        const doneReg = `%ptdone_${ifIdx}`;
        lines.push(`  ${doneReg} = icmp eq i32 ${iReg}, ${lenReg}`);
        lines.push(`  br i1 ${doneReg}, label %ptexit_${ifIdx}, label %ptbody_begin_${ifIdx}`);
        lines.push('');

        // Loop body begin — decide whether to add ", " separator
        lines.push(`ptbody_begin_${ifIdx}:`);
        const needSepReg = `%ptns_${ifIdx}`;
        lines.push(`  ${needSepReg} = icmp ne i32 ${iReg}, 0`);
        lines.push(`  br i1 ${needSepReg}, label %ptaddsep_${ifIdx}, label %ptaftersep_${ifIdx}`);
        lines.push('');

        // Add separator
        lines.push(`ptaddsep_${ifIdx}:`);
        const sepGep    = this.rawStringGep(', ');
        const accSepReg = `%ptaccsep_${ifIdx}`;
        lines.push(`  ${accSepReg} = call i8* @concat(i8* ${accReg}, i8* ${sepGep})`);
        lines.push(`  br label %ptaftersep_${ifIdx}`);
        lines.push('');

        // After separator phi
        lines.push(`ptaftersep_${ifIdx}:`);
        const accMidReg = `%ptaccmid_${ifIdx}`;
        lines.push(`  ${accMidReg} = phi i8* [ ${accReg}, %ptbody_begin_${ifIdx} ], [ ${accSepReg}, %ptaddsep_${ifIdx} ]`);

        // Get element and convert to string
        const rawElemReg  = `%ptraw_${ifIdx}`;
        const elemPtrReg  = `%ptelem_${ifIdx}`;
        const elemStrReg  = `%ptes_${ifIdx}`;
        const accNewReg   = `%ptacc_new_${ifIdx}`;
        const iNextReg    = `%ptinext_${ifIdx}`;
        lines.push(`  ${rawElemReg} = call i8* @ptrarray_get(%PtrArray* %arr, i32 ${iReg})`);
        lines.push(`  ${elemPtrReg} = bitcast i8* ${rawElemReg} to %${structName}*`);
        lines.push(`  ${elemStrReg} = call i8* @${structName}_autoToString(%${structName}* ${elemPtrReg})`);
        lines.push(`  ${accNewReg} = call i8* @concat(i8* ${accMidReg}, i8* ${elemStrReg})`);
        lines.push(`  ${iNextReg} = add i32 ${iReg}, 1`);
        lines.push(`  br label %ptbody_end_${ifIdx}`);
        lines.push('');

        // Body end (phi predecessor for loop head)
        lines.push(`ptbody_end_${ifIdx}:`);
        lines.push(`  br label %pthead_${ifIdx}`);
        lines.push('');

        // Exit
        lines.push(`ptexit_${ifIdx}:`);
        const closeGep  = this.rawStringGep(']');
        const resultReg = `%ptresult_${ifIdx}`;
        lines.push(`  ${resultReg} = call i8* @concat(i8* ${accReg}, i8* ${closeGep})`);
        lines.push(`  ret i8* ${resultReg}`);
        lines.push('}');
        lines.push('');
        this.autoGeneratedFunctions.push(lines.join('\n'));
    }

    // ── Cast helpers ──────────────────────────────────────────────────────────

    /** True when a numeric cast from `from` to `to` is meaningful. */
    private canCast(from: string, to: string): boolean {
        if (from === to) return false;
        const isFloat = isFloatTy;
        return (isIntegerTy(from) && isIntegerTy(to))   ||
               (isIntegerTy(from) && isFloat(to))       ||
               (isFloat(from)     && isIntegerTy(to))   ||
               (isFloat(from)     && isFloat(to));
    }

    /**
     * Emit a cast instruction (`sext`/`zext`, `trunc`, `sitofp`/`uitofp`,
     * `fptosi`/`fptoui`, `fpext`, `fptrunc`) and return the result register.
     * Unsigned integer sentinels (u8, u32 …) use zero-extending / unsigned ops.
     */
    private emitCast(lines: string[], val: string, fromTy: string, toTy: string): string {
        if (fromTy === toTy) return val;
        const isFloat  = isFloatTy;
        const isSigned = (t: string) => t.startsWith('i');
        const bits     = (t: string) => parseInt(t.slice(1), 10);
        const irFrom   = toLLVM(fromTy);
        const irTo     = toLLVM(toTy);
        // If both sentinels resolve to the same LLVM type (e.g. inf → double),
        // no instruction is needed — the value is already in the right shape.
        if (irFrom === irTo) return val;
        let instr: string;
        if (isIntegerTy(fromTy) && isIntegerTy(toTy)) {
            if (bits(irFrom) < bits(irTo)) {
                // Widening: zext for unsigned source, sext for signed source
                instr = isSigned(fromTy) ? 'sext' : 'zext';
            } else {
                instr = 'trunc';
            }
        } else if (isIntegerTy(fromTy) && isFloat(toTy)) {
            instr = isSigned(fromTy) ? 'sitofp' : 'uitofp';
        } else if (isFloat(fromTy) && isIntegerTy(toTy)) {
            instr = isSigned(toTy) ? 'fptosi' : 'fptoui';
        } else if (irFrom === 'float'  && irTo === 'double') {
            instr = 'fpext';
        } else if (irFrom === 'double' && irTo === 'float') {
            instr = 'fptrunc';
        } else {
            lines.push(`  ; WARNING: unsupported cast ${fromTy} → ${toTy}`);
            return val;
        }
        const tmp = `%${this.tmpIdx++}`;
        lines.push(`  ${tmp} = ${instr} ${irFrom} ${val} to ${irTo}`);
        return tmp;
    }

    // ── Assignment ────────────────────────────────────────────────────────────

    private emitAssignment(lines: string[], stmt: AssignmentStatement, varCtx: VarCtx): void {
        const name = stmt.target.$refText, info = varCtx.get(name);
        if (!info) return;
        const ty  = info.llvmType;
        const val = this.emitExpr(lines, stmt.value, varCtx, ty);
        lines.push(`  store ${toLLVM(ty)} ${val}, ${ptrOf(ty)} ${info.allocaName}, align ${alignOf(ty)}`);
    }

    // ── Print ─────────────────────────────────────────────────────────────────
    //
    // Type-aware: chooses between string (pass as format), integer (%d),
    // or float/double (%f) based on the inferred type of the expression.

    private emitPrint(lines: string[], stmt: PrintStatement, varCtx: VarCtx): void {
        const exprTy = this.inferType(stmt.value, varCtx);

        if (isNumberTy(exprTy)) {
            // Dynamic Number — delegate fully to number_print (handles all kinds)
            const val = this.emitExpr(lines, stmt.value, varCtx, NUMBER_TY);
            lines.push(`  call void @number_print(%Number* ${val})`);
            return;
        }

        if (isBufferTy(exprTy)) {
            // Buffer — delegate to buffer_print which prints [b0, b1, ...]\n
            // If buffer_print is not already declared via a stdlib extern import,
            // set the flag so we emit a declare in the header.
            if (!this.externTable.has('buffer_print')) this.needsBufferPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, BUFFER_TY);
            lines.push(`  call void @buffer_print(%Buffer* ${val})`);
            return;
        }

        if (isIntArrayTy(exprTy)) {
            // IntArray — delegate to intarray_print which prints [v0, v1, ...]\n
            if (!this.externTable.has('intarray_print')) this.needsIntArrayPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, INTARRAY_TY);
            lines.push(`  call void @intarray_print(%IntArray* ${val})`);
            return;
        }

        if (isStringArrayTy(exprTy)) {
            // StringArray — delegate to stringarray_print which prints ["s0", "s1", ...]\n
            if (!this.externTable.has('stringarray_print')) this.needsStringArrayPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, STRINGARRAY_TY);
            lines.push(`  call void @stringarray_print(%StringArray* ${val})`);
            return;
        }

        if (isNumberArrayTy(exprTy)) {
            // NumberArray — delegate to numberarray_print
            if (!this.externTable.has('numberarray_print')) this.needsNumberArrayPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, NUMBERARRAY_TY);
            lines.push(`  call void @numberarray_print(%NumberArray* ${val})`);
            return;
        }

        if (isAnyArrayTy(exprTy)) {
            // AnyArray — delegate to anyarray_print
            if (!this.externTable.has('anyarray_print')) this.needsAnyArrayPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, ANYARRAY_TY);
            lines.push(`  call void @anyarray_print(%AnyArray* ${val})`);
            return;
        }

        if (isBoolArrayTy(exprTy)) {
            // BoolArray — delegate to boolarray_print
            if (!this.externTable.has('boolarray_print')) this.needsBoolArrayPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, BOOLARRAY_TY);
            lines.push(`  call void @boolarray_print(%BoolArray* ${val})`);
            return;
        }

        if (isIntSetTy(exprTy)) {
            if (!this.externTable.has('intset_print')) this.needsIntSetPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, INTSET_TY);
            lines.push(`  call void @intset_print(%IntSet* ${val})`);
            return;
        }

        if (isStringSetTy(exprTy)) {
            if (!this.externTable.has('stringset_print')) this.needsStringSetPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, STRINGSET_TY);
            lines.push(`  call void @stringset_print(%StringSet* ${val})`);
            return;
        }

        if (isBoolSetTy(exprTy)) {
            if (!this.externTable.has('boolset_print')) this.needsBoolSetPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, BOOLSET_TY);
            lines.push(`  call void @boolset_print(%BoolSet* ${val})`);
            return;
        }

        if (isFloatArrayTy(exprTy)) {
            if (!this.externTable.has('floatarray_print')) this.needsFloatArrayPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, FLOATARRAY_TY);
            lines.push(`  call void @floatarray_print(%FloatArray* ${val})`);
            return;
        }

        if (isDoubleArrayTy(exprTy)) {
            if (!this.externTable.has('doublearray_print')) this.needsDoubleArrayPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, DOUBLEARRAY_TY);
            lines.push(`  call void @doublearray_print(%DoubleArray* ${val})`);
            return;
        }

        if (isFloatSetTy(exprTy)) {
            if (!this.externTable.has('floatset_print')) this.needsFloatSetPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, FLOATSET_TY);
            lines.push(`  call void @floatset_print(%FloatSet* ${val})`);
            return;
        }

        if (isDoubleSetTy(exprTy)) {
            if (!this.externTable.has('doubleset_print')) this.needsDoubleSetPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, DOUBLESET_TY);
            lines.push(`  call void @doubleset_print(%DoubleSet* ${val})`);
            return;
        }

        if (isNumberSetTy(exprTy)) {
            if (!this.externTable.has('numberset_print')) this.needsNumberSetPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, NUMBERSET_TY);
            lines.push(`  call void @numberset_print(%NumberSet* ${val})`);
            return;
        }

        if (isIntIntMapTy(exprTy)) {
            if (!this.externTable.has('intintmap_print')) this.needsIntIntMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, INTINTMAP_TY);
            lines.push(`  call void @intintmap_print(%IntIntMap* ${val})`);
            return;
        }

        if (isIntStringMapTy(exprTy)) {
            if (!this.externTable.has('intstringmap_print')) this.needsIntStringMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, INTSTRINGMAP_TY);
            lines.push(`  call void @intstringmap_print(%IntStringMap* ${val})`);
            return;
        }

        if (isStringIntMapTy(exprTy)) {
            if (!this.externTable.has('stringintmap_print')) this.needsStringIntMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, STRINGINTMAP_TY);
            lines.push(`  call void @stringintmap_print(%StringIntMap* ${val})`);
            return;
        }

        if (isStringStringMapTy(exprTy)) {
            if (!this.externTable.has('stringstringmap_print')) this.needsStringStringMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, STRINGSTRINGMAP_TY);
            lines.push(`  call void @stringstringmap_print(%StringStringMap* ${val})`);
            return;
        }

        if (isIntPtrMapTy(exprTy)) {
            if (!this.externTable.has('intptrmap_print')) this.needsIntPtrMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, INTPTRMAP_TY);
            lines.push(`  call void @intptrmap_print(%IntPtrMap* ${val})`);
            return;
        }

        if (isStringPtrMapTy(exprTy)) {
            if (!this.externTable.has('stringptrmap_print')) this.needsStringPtrMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, STRINGPTRMAP_TY);
            lines.push(`  call void @stringptrmap_print(%StringPtrMap* ${val})`);
            return;
        }

        if (isPtrIntMapTy(exprTy)) {
            if (!this.externTable.has('ptrintmap_print')) this.needsPtrIntMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, PTRINTMAP_TY);
            lines.push(`  call void @ptrintmap_print(%PtrIntMap* ${val})`);
            return;
        }

        if (isPtrStrMapTy(exprTy)) {
            if (!this.externTable.has('ptrstrmap_print')) this.needsPtrStrMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, PTRSTRMAP_TY);
            lines.push(`  call void @ptrstrmap_print(%PtrStringMap* ${val})`);
            return;
        }

        if (isPtrPtrMapTy(exprTy)) {
            if (!this.externTable.has('ptrptrmap_print')) this.needsPtrPtrMapPrintDecl = true;
            const val = this.emitExpr(lines, stmt.value, varCtx, PTRPTRMAP_TY);
            lines.push(`  call void @ptrptrmap_print(%PtrPtrMap* ${val})`);
            return;
        }

        if (isPtrArrayTy(exprTy)) {
            // PtrArray (Array<StructType>) — auto-generate struct toString + PtrArray
            // toString IR functions, then call the PtrArray toString and printf %s\n.
            let elemStructName: string | null = null;
            if (isVariableRef(stmt.value)) {
                const varName = (stmt.value as VariableRef).ref.$refText;
                const info = varCtx.get(varName);
                if (info) elemStructName = this.ptrArrayElemMap.get(info.allocaName) ?? null;
            }
            if (elemStructName) {
                // Lazily emit auto-generated functions (idempotent)
                const toStringFnName = `${elemStructName}_PtrArray_toString`;
                if (!this.emittedAutoFunctions.has(toStringFnName)) {
                    this.emittedAutoFunctions.add(toStringFnName);
                    this.emitAutoStructToStringFn(elemStructName);
                    this.emitAutoStructPtrArrayToStringFn(elemStructName);
                }
                const val    = this.emitExpr(lines, stmt.value, varCtx, PTRARRAY_TY);
                const strReg = `%${this.tmpIdx++}`;
                lines.push(`  ${strReg} = call i8* @${toStringFnName}(%PtrArray* ${val})`);
                const sc     = this.strMap.get('%s')!;
                const fmtPtr = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
                const tmp    = `%${this.tmpIdx++}`;
                lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${strReg})`);
            } else {
                // Fallback: element struct type unknown — print placeholder
                lines.push(`  ; WARNING: cannot determine PtrArray element type for print()`);
                this.emitExpr(lines, stmt.value, varCtx, PTRARRAY_TY);
                const sc     = this.strMap.get('%s')!;
                const fmtPtr = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
                this.rawInternString('[<PtrArray>]');
                const tmp    = `%${this.tmpIdx++}`;
                lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${this.rawStringGep('[<PtrArray>]')})`);
            }
            return;
        }

        if (exprTy === 'i1') {
            // Boolean: select "true" or "false" then print as %s\n.
            // This path is unconditional so that comparison results (addr_x != addr_y,
            // a < b, etc.) always print "true"/"false" regardless of whether the Bool
            // stdlib is imported and has a toString() extension in the table.
            const val      = this.emitExpr(lines, stmt.value, varCtx, 'i1');
            const strReg   = `%${this.tmpIdx++}`;
            const trueGep  = this.rawStringGep('true');
            const falseGep = this.rawStringGep('false');
            lines.push(`  ${strReg} = select i1 ${val}, i8* ${trueGep}, i8* ${falseGep}`);
            const sc     = this.strMap.get('%s')!;
            const fmtPtr = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
            const tmp    = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${strReg})`);
        } else if (exprTy === 'i8*') {
            // All string values are stored as raw (no trailing \n) pointers.
            // Always use `%s\n` as the format so printf adds exactly one newline.
            // This is also safer than passing user data as a format string directly.
            const val    = this.emitExpr(lines, stmt.value, varCtx, 'i8*');
            const sc     = this.strMap.get('%s')!;
            const fmtPtr = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
            const tmp    = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${val})`);
        } else if (this.extTable.get(exprTy)?.has('toString')) {
            // Type with a toString() extension method — call it, then print as %s\n.
            // Covers custom struct types, etc.
            const entry  = this.extTable.get(exprTy)!.get('toString')!;
            const val    = this.emitExpr(lines, stmt.value, varCtx, exprTy);
            const strReg = `%${this.tmpIdx++}`;
            lines.push(`  ${strReg} = call i8* @${entry.typeName}_toString(${toLLVM(exprTy)} ${val})`);
            const sc     = this.strMap.get('%s')!;
            const fmtPtr = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
            const tmp    = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${strReg})`);
        } else if (isFloatTy(exprTy)) {
            // Float / double — use %f format
            const sc     = this.strMap.get('%.15g')!;
            const fmtPtr = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
            let   val    = this.emitExpr(lines, stmt.value, varCtx, exprTy);
            // Variadic functions require float → double promotion
            if (toLLVM(exprTy) === 'float') {
                const promoted = `%${this.tmpIdx++}`;
                lines.push(`  ${promoted} = fpext float ${val} to double`);
                val = promoted;
            }
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, double ${val})`);
        } else if (isSimdVectorTy(exprTy)) {
            // SIMD vector type — cannot be printed directly via printf.
            // Import stdlib/simd.code to add toString() and enable print().
            lines.push(`  ; print(<simd>): import stdlib/simd.code to enable SIMD printing`);
        } else {
            // Integer — pick format string based on width and signedness:
            //   signed   narrow (i1/i8/i16/i32)  → %d   (sext to i32)
            //   unsigned narrow (u8/u16/u32)      → %u   (zext to i32)
            //   signed   wide   (i64/i128+)       → %ld  (pass as-is)
            //   unsigned wide   (u64/u128+)       → %lu  (pass as-is)
            const isUint = isUnsignedTy(exprTy);
            const isWide = ['i64','i128','i256','i512','u64','u128','u256','u512'].includes(exprTy);
            const fmtKey = isWide ? (isUint ? '%lu' : '%ld') : (isUint ? '%u' : '%d');
            const sc     = this.strMap.get(fmtKey)!;
            const fmtPtr = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
            const irTy   = toLLVM(exprTy);
            let   val    = this.emitExpr(lines, stmt.value, varCtx, exprTy);
            let   printTy: string;
            if (isWide) {
                // Wide integers are passed at their natural size.
                printTy = irTy;
            } else {
                // Narrow integers are promoted to 32-bit for printf's variadic ABI.
                printTy = 'i32';
                const needsWiden = ['i1', 'i8', 'i16', 'u8', 'u16'].includes(exprTy);
                if (needsWiden) {
                    // bool and unsigned → zero-extend; signed → sign-extend
                    const extOp = (exprTy === 'i1' || isUint) ? 'zext' : 'sext';
                    const ext   = `%${this.tmpIdx++}`;
                    lines.push(`  ${ext} = ${extOp} ${irTy} ${val} to i32`);
                    val = ext;
                }
                // i32 / u32 are already 32-bit — no extension needed; use 'i32'
            }
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, ${printTy} ${val})`);
        }
    }

    // ── write() built-in ─────────────────────────────────────────────────────
    //
    // write(s) prints a string without a trailing newline.
    // Counterpart to print(s) which adds \n.
    //
    // Only string (i8*) and numeric types are supported.  For strings we use
    // a raw "%s" format constant (no \n).  For numeric types we fall back to
    // the same format strings used by print().
    //
    // Called from emitCallInstr when callee === 'write'.

    private emitWriteBuiltin(
        lines:   string[],
        argExpr: Expression,
        varCtx:  VarCtx,
        capture: boolean,
    ): string {
        const exprTy = this.inferType(argExpr, varCtx);

        if (exprTy === 'i8*') {
            // String — printf("%s", val)  (raw "%s", no \n)
            const val = this.emitExpr(lines, argExpr, varCtx, 'i8*');
            const sc  = this.rawStrMap.get('%s');
            if (!sc) {
                // Fallback: use the newline-free path via rawInternString pre-pass.
                // This path should never be hit because collectStringsInStmt
                // always interns raw '%s' for write() calls.
                return 'void';
            }
            const fmtPtr = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
            const tmp    = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${val})`);
            return capture ? tmp : 'void';
        }

        if (isFloatTy(exprTy)) {
            // Ensure format strings are interned
            if (!this.strMap.has('%.15g')) this.internString('%.15g');
            const sc      = this.strMap.get('%.15g')!;
            const fmtPtr  = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
            let   val     = this.emitExpr(lines, argExpr, varCtx, exprTy);
            if (toLLVM(exprTy) === 'float') {
                const prom = `%${this.tmpIdx++}`;
                lines.push(`  ${prom} = fpext float ${val} to double`);
                val = prom;
            }
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, double ${val})`);
            return capture ? tmp : 'void';
        }

        // Integer types
        const isUint = isUnsignedTy(exprTy);
        const isWide = ['i64','i128','i256','i512','u64','u128','u256','u512'].includes(exprTy);
        const fmtKey = isWide ? (isUint ? '%lu' : '%ld') : (isUint ? '%u' : '%d');
        if (!this.strMap.has(fmtKey)) this.internString(fmtKey);
        const sc      = this.strMap.get(fmtKey)!;
        const fmtPtr  = `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
        const irTy    = toLLVM(exprTy);
        let   val     = this.emitExpr(lines, argExpr, varCtx, exprTy);
        let   printTy = 'i32';
        if (isWide) {
            printTy = irTy;
        } else {
            const needsWiden = ['i1', 'i8', 'i16', 'u8', 'u16'].includes(exprTy);
            if (needsWiden) {
                const extOp = (exprTy === 'i1' || isUint) ? 'zext' : 'sext';
                const ext   = `%${this.tmpIdx++}`;
                lines.push(`  ${ext} = ${extOp} ${irTy} ${val} to i32`);
                val = ext;
            }
        }
        const tmp = `%${this.tmpIdx++}`;
        lines.push(`  ${tmp} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, ${printTy} ${val})`);
        return capture ? tmp : 'void';
    }

    // ── Defer flush ───────────────────────────────────────────────────────────
    //
    // Must be called before every `ret` instruction (explicit or implicit).
    // Defers are executed in LIFO order (last registered → first executed),
    // matching Go/Swift semantics.

    private flushDefers(lines: string[], varCtx: VarCtx): void {
        if (this.currentDefers.length === 0) return;
        lines.push('  ; ── deferred calls ──────────────────────────────────');
        for (let i = this.currentDefers.length - 1; i >= 0; i--) {
            const target = this.currentDefers[i];
            if (target.kind === 'expr') {
                // Emit the expression for its side-effects; discard the result.
                this.emitExpr(lines, target.expr, varCtx, 'void');
            } else {
                // Synthesised dispose() call from a `using` declaration.
                const info = varCtx.get(target.varName);
                if (!info) continue;
                const extMethods = this.extTable.get(info.llvmType);
                if (extMethods?.has('dispose')) {
                    const entry = extMethods.get('dispose')!;
                    this.emitExtensionMethodCall(lines, info, entry, 'dispose', [], varCtx, false);
                    continue;
                }
                // Fall back to generic extension dispose (for generic types)
                const genInfo = this.mangledTypeIndex.get(info.llvmType);
                if (genInfo) {
                    const genMethods = this.genericExtIndex.get(genInfo.typeDecl.name);
                    if (genMethods?.has('dispose')) {
                        const gEntry = genMethods.get('dispose')!;
                        this.emitGenericExtensionMethodCall(lines, info, gEntry, 'dispose', [], varCtx, false, genInfo.env);
                    }
                }
            }
        }
        lines.push('  ; ────────────────────────────────────────────────────');
    }

    // ── Panic ─────────────────────────────────────────────────────────────────
    //
    // panic(msg) lowers to:
    //   call void @runtime_panic(i8* %msg)
    //   unreachable
    //
    // The `unreachable` LLVM instruction tells the optimizer this block has no
    // successors — enabling dead-code elimination after the panic call.
    // The statement is a block terminator (returns true from emitStatement).
    //
    // Accepts:
    //   panic("literal message")        ← plain string (original behavior)
    //   panic(errorVariable)            ← any type with toString() extension
    //   panic(MyError.new("message"))   ← Error protocol conformer

    private emitPanic(lines: string[], stmt: PanicStatement, varCtx: VarCtx): void {
        if (!this.externTable.has('runtime_panic')) this.needsPanicDecl = true;

        // ── Coerce the argument to i8* ─────────────────────────────────────────
        // If the argument is a type that has a toString() extension method (e.g.
        // any Error-protocol conformer, or any Displayable type), call toString()
        // first to get the i8* message string.  This lets callers write:
        //
        //   panic(MyError.new("index out of bounds"));
        //   panic(http);   // HttpError → "HttpError(404): NotFound"
        //
        // For plain strings (i8*) and intrinsics, the original path is used.
        const exprTy = this.inferType(stmt.value, varCtx);
        let msgVal: string;

        if (exprTy !== 'i8*' && this.extTable.get(exprTy)?.has('toString')) {
            // Struct / intrinsic type with toString() extension method
            const entry = this.extTable.get(exprTy)!.get('toString')!;
            const val   = this.emitExpr(lines, stmt.value, varCtx, exprTy);
            msgVal      = `%${this.tmpIdx++}`;
            lines.push(`  ${msgVal} = call i8* @${entry.typeName}_toString(${toLLVM(exprTy)} ${val})`);
        } else if (exprTy !== 'i8*') {
            // Check generic enum types (e.g. a custom error-like enum)
            const enumGenInfo = this.mangledEnumTypeIndex.get(exprTy);
            const enumMethod  = enumGenInfo?.decl.members
                .filter(isEnumMethod)
                .find((m: EnumMethod) => m.name === 'toString');
            if (enumMethod) {
                const val  = this.emitExpr(lines, stmt.value, varCtx, exprTy);
                const ctor = `${enumGenInfo!.decl.name}_${exprTy.replace(/^%/, '').replace(/\*$/, '')}_toString`;
                msgVal     = `%${this.tmpIdx++}`;
                lines.push(`  ${msgVal} = call i8* @${ctor}(${toLLVM(exprTy)} ${val})`);
            } else {
                // Fallback: coerce whatever we have to i8*
                msgVal = this.emitExpr(lines, stmt.value, varCtx, 'i8*');
            }
        } else {
            // Already i8* (plain string)
            msgVal = this.emitExpr(lines, stmt.value, varCtx, 'i8*');
        }

        lines.push(`  call void @runtime_panic(i8* ${msgVal})`);
        lines.push('  unreachable');
    }

    // ── Return ────────────────────────────────────────────────────────────────
    //
    // Tail-call detection: when the return value is a direct function call
    // (not buried inside an arithmetic expression), we set isTailCall = true.
    // emitCallInstrFn then decides whether to emit `musttail call` or `tail call`.
    //
    //   return foo(args)          ← tail call  ✓
    //   return foo(args) + bar()  ← NOT a tail call (add is the last op)

    private emitReturn(lines: string[], stmt: ReturnStatement, varCtx: VarCtx): void {
        if (!stmt.value) {
            this.flushDefers(lines, varCtx);
            lines.push('  ret void');
            return;
        }

        // Defensive: if the enclosing function is void, discard the value and
        // emit `ret void`.  The validator should have already reported an error
        // for this case, so this path only runs if validation was bypassed.
        if (this.currentFnRetTy === 'void') {
            this.emitExpr(lines, stmt.value, varCtx, 'void'); // evaluate for side-effects
            this.flushDefers(lines, varCtx);
            lines.push('  ret void');
            return;
        }

        const retTy = this.currentFnRetTy;

        // Direct call in tail position → annotate as tail call
        // (skip when memoization is active — we need to store the result first;
        //  also skip when defers are active — they must run before the ret)
        if (isCallExpression(stmt.value) && !this.currentMemoGlobal && this.currentDefers.length === 0) {
            const ce  = stmt.value as CallExpression;
            const val = this.emitCallInstr(lines, ce.callee, ce.args, varCtx, /*capture=*/true, /*tail=*/true);
            lines.push(`  ret ${toLLVM(retTy)} ${val}`);
            return;
        }

        // Use raw strings (no trailing \n) for string-returning functions
        const isStrReturn = retTy === 'i8*';
        const val = this.emitExpr(lines, stmt.value, varCtx, retTy, isStrReturn);
        this.emitMemoStore(lines, val);
        this.flushDefers(lines, varCtx);
        lines.push(`  ret ${toLLVM(retTy)} ${val}`);
    }

    /** Store `val` in the current function's memo table (no-op if not memoizing). */
    private emitMemoStore(lines: string[], val: string): void {
        if (!this.currentMemoGlobal || !this.currentMemoParamAlloca) return;
        const keyReg = `%${this.tmpIdx++}`;
        lines.push(`  ${keyReg} = load %Number*, %Number** ${this.currentMemoParamAlloca}, align 8`);
        lines.push(`  call void @number_memo_set1(i8** @${this.currentMemoGlobal}, %Number* ${keyReg}, %Number* ${val})`);
    }

    // ── Call statement ────────────────────────────────────────────────────────

    private emitCallStatement(lines: string[], stmt: CallStatement, varCtx: VarCtx): void {
        this.emitCallInstr(lines, stmt.callee, stmt.args, varCtx, false);
    }

    // ── If statement ─────────────────────────────────────────────────────────
    //
    // Returns true when BOTH branches terminate, meaning the merge block is
    // unreachable (we emit `unreachable` to keep LLVM validation happy).

    private emitIfStatement(lines: string[], stmt: IfStatement, varCtx: VarCtx): boolean {
        const idx        = this.ifIdx++;
        const thenLabel  = `if.then.${idx}`;
        const mergeLabel = `if.merge.${idx}`;
        const hasElse    = !!(stmt.elseBlock ?? stmt.elseIf);
        const falseLabel = hasElse ? `if.else.${idx}` : mergeLabel;

        const cmpReg = this.emitCondition(lines, stmt.condition, varCtx);
        lines.push(`  br i1 ${cmpReg}, label %${thenLabel}, label %${falseLabel}`);

        // ── then ──
        lines.push('');
        lines.push(`${thenLabel}:`);
        this.currentLabel = thenLabel;
        const thenTerminated = this.emitStatements(lines, stmt.thenBlock.statements, varCtx);
        if (!thenTerminated) lines.push(`  br label %${mergeLabel}`);

        // ── else / else-if (optional) ──
        let elseTerminated = false;
        if (hasElse) {
            const elseLabel = `if.else.${idx}`;
            lines.push('');
            lines.push(`${elseLabel}:`);
            this.currentLabel = elseLabel;

            if (stmt.elseIf) {
                // else-if: inline the nested IfStatement into this label.
                // We must not double-push the merge block — treat the nested
                // if as-is and redirect its merge target to our own mergeLabel
                // by patching the last branch after emission.
                elseTerminated = this.emitIfStatement(lines, stmt.elseIf, varCtx);
                if (!elseTerminated) lines.push(`  br label %${mergeLabel}`);
            } else {
                elseTerminated = this.emitStatements(lines, stmt.elseBlock!.statements, varCtx);
                if (!elseTerminated) lines.push(`  br label %${mergeLabel}`);
            }
        }

        // ── merge ──
        lines.push('');
        lines.push(`${mergeLabel}:`);
        this.currentLabel = mergeLabel;

        if (thenTerminated && elseTerminated) {
            lines.push('  unreachable');
            return true; // caller should not add more code to this block
        }
        return false;
    }

    // ── While statement ───────────────────────────────────────────────────────
    //
    // Structure:
    //   br label %while.cond.N
    // while.cond.N:
    //   %cmp = icmp ...
    //   br i1 %cmp, label %while.body.N, label %while.merge.N
    // while.body.N:
    //   <body>
    //   br label %while.cond.N    ← loop-back edge (unless body terminates)
    // while.merge.N:              ← fall-through after the loop

    private emitWhileStatement(lines: string[], stmt: WhileStatement, varCtx: VarCtx): void {
        const idx        = this.ifIdx++;
        const condLabel  = `while.cond.${idx}`;
        const bodyLabel  = `while.body.${idx}`;
        const mergeLabel = `while.merge.${idx}`;

        // Fall into the condition check
        lines.push(`  br label %${condLabel}`);

        // ── condition ──
        lines.push('');
        lines.push(`${condLabel}:`);
        this.currentLabel = condLabel;
        const cmpReg = this.emitCondition(lines, stmt.condition, varCtx);
        lines.push(`  br i1 ${cmpReg}, label %${bodyLabel}, label %${mergeLabel}`);

        // ── body ──
        lines.push('');
        lines.push(`${bodyLabel}:`);
        this.currentLabel = bodyLabel;
        this.loopStack.push({ continueLabel: condLabel, breakLabel: mergeLabel });
        const bodyTerminated = this.emitStatements(lines, stmt.body.statements, varCtx);
        this.loopStack.pop();
        if (!bodyTerminated) lines.push(`  br label %${condLabel}`);

        // ── merge (after loop) ──
        lines.push('');
        lines.push(`${mergeLabel}:`);
        this.currentLabel = mergeLabel;
        // While is never a terminator from the caller's perspective
    }

    // ── For statement ─────────────────────────────────────────────────────────
    //
    // Desugars to a while loop with an explicit init and update step:
    //
    //   for (let i: int = 0; i < n; i++) { body }
    //
    // Emits:
    //   <init alloca + store>
    //   br label %for.cond.N
    // for.cond.N:
    //   %cmp = icmp ...
    //   br i1 %cmp, label %for.body.N, label %for.merge.N
    // for.body.N:
    //   <body>
    //   <update: i++ / i-- / i = expr>
    //   br label %for.cond.N
    // for.merge.N:

    private emitForStatement(lines: string[], stmt: ForStatement, varCtx: VarCtx): void {
        const idx          = this.ifIdx++;
        const condLabel    = `for.cond.${idx}`;
        const bodyLabel    = `for.body.${idx}`;
        const updateLabel  = `for.update.${idx}`;   // continue lands here
        const mergeLabel   = `for.merge.${idx}`;    // break lands here

        // ── init ──
        this.emitVarDecl(lines, stmt.init, varCtx);
        lines.push(`  br label %${condLabel}`);

        // ── condition ──
        lines.push('');
        lines.push(`${condLabel}:`);
        this.currentLabel = condLabel;
        const cmpReg = this.emitCondition(lines, stmt.condition, varCtx);
        lines.push(`  br i1 ${cmpReg}, label %${bodyLabel}, label %${mergeLabel}`);

        // ── body ──
        lines.push('');
        lines.push(`${bodyLabel}:`);
        this.currentLabel = bodyLabel;
        // continue → updateLabel  /  break → mergeLabel
        this.loopStack.push({ continueLabel: updateLabel, breakLabel: mergeLabel });
        const bodyTerminated = this.emitStatements(lines, stmt.body.statements, varCtx);
        this.loopStack.pop();
        if (!bodyTerminated) lines.push(`  br label %${updateLabel}`);

        // ── update (explicit block so `continue` can jump here) ──
        lines.push('');
        lines.push(`${updateLabel}:`);
        this.currentLabel = updateLabel;
        this.emitForUpdate(lines, stmt.update, varCtx);
        lines.push(`  br label %${condLabel}`);

        // ── merge (after loop) ──
        lines.push('');
        lines.push(`${mergeLabel}:`);
        this.currentLabel = mergeLabel;
    }

    // Emit the update clause of a for loop: i++ | i-- | i = expr
    private emitForUpdate(lines: string[], update: ForUpdate, varCtx: VarCtx): void {
        const name = update.target;
        const info = varCtx.get(name);
        if (!info) return;
        const ty    = info.llvmType;
        const irTy  = toLLVM(ty);
        const align = alignOf(ty);

        if (update.increment || update.decrement) {
            // i++ → i = i + 1 ;  i-- → i = i - 1
            const cur = `%${this.tmpIdx++}`;
            lines.push(`  ${cur} = load ${irTy}, ${ptrOf(ty)} ${info.allocaName}, align ${align}`);
            const result = `%${this.tmpIdx++}`;
            const op = update.increment ? 'add' : 'sub';
            lines.push(`  ${result} = ${op} ${irTy} ${cur}, 1`);
            lines.push(`  store ${irTy} ${result}, ${ptrOf(ty)} ${info.allocaName}, align ${align}`);
        } else if (update.value) {
            // i = expr
            const val = this.emitExpr(lines, update.value, varCtx, ty);
            lines.push(`  store ${irTy} ${val}, ${ptrOf(ty)} ${info.allocaName}, align ${align}`);
        }
    }

    // ── Break / Continue ──────────────────────────────────────────────────────

    /**
     * `break;` — unconditional branch to the enclosing loop's merge block.
     * Must only be called when `loopStack` is non-empty (i.e. inside a loop).
     */
    private emitBreakStatement(lines: string[]): void {
        const top = this.loopStack[this.loopStack.length - 1];
        lines.push(`  br label %${top.breakLabel}`);
    }

    /**
     * `continue;` — unconditional branch to the enclosing loop's continue target.
     *   • while loop: jumps to the condition-check block
     *   • for   loop: jumps to the update block (which then checks the condition)
     */
    private emitContinueStatement(lines: string[]): void {
        const top = this.loopStack[this.loopStack.length - 1];
        lines.push(`  br label %${top.continueLabel}`);
    }

    // ── Compound assignment ────────────────────────────────────────────────────
    //
    //   x += 1      →  x = x + 1
    //   s += " !"   →  s = concat(s, " !")   (string type)

    private emitCompoundAssign(lines: string[], stmt: CompoundAssignStatement, varCtx: VarCtx): void {
        const name = stmt.target.$refText;
        const info = varCtx.get(name);
        if (!info) return;
        const ty    = info.llvmType;
        const irTy  = toLLVM(ty);
        const align = alignOf(ty);

        // Load current value
        const cur = `%${this.tmpIdx++}`;
        lines.push(`  ${cur} = load ${irTy}, ${ptrOf(ty)} ${info.allocaName}, align ${align}`);

        // Compute RHS (coerce to the variable's type)
        const rhs = this.emitExpr(lines, stmt.value, varCtx, ty);

        // Apply operator
        const res = `%${this.tmpIdx++}`;
        if (ty === 'i8*') {
            // String: only += makes sense → call concat()
            if (stmt.op === '+=') {
                this.needsConcatDecl = true;
                lines.push(`  ${res} = call i8* @concat(i8* ${cur}, i8* ${rhs})`);
            } else {
                // Other compound ops on strings are no-ops (guard against misuse)
                lines.push(`  ; WARNING: unsupported compound op ${stmt.op} on string`);
                return;
            }
        } else if (ty === 'double') {
            const opMap: Record<string, string> = { '+=': 'fadd', '-=': 'fsub', '*=': 'fmul', '/=': 'fdiv' };
            lines.push(`  ${res} = ${opMap[stmt.op]} double ${cur}, ${rhs}`);
        } else {
            // Integer types (signed — sdiv for /=)
            const opMap: Record<string, string> = { '+=': 'add', '-=': 'sub', '*=': 'mul', '/=': 'sdiv' };
            lines.push(`  ${res} = ${opMap[stmt.op]} ${irTy} ${cur}, ${rhs}`);
        }

        lines.push(`  store ${irTy} ${res}, ${ptrOf(ty)} ${info.allocaName}, align ${align}`);
    }

    // ── If expression ─────────────────────────────────────────────────────────
    //
    // Emits both arms + a phi in the merge block. this.currentLabel is updated
    // as we move through blocks so nested if-exprs produce correct phi sources.

    private emitIfExpr(
        lines:      string[],
        expr:       IfExpression,
        varCtx:     VarCtx,
        expectedTy: string,
    ): string {
        const idx        = this.ifIdx++;
        const thenLabel  = `if.then.${idx}`;
        const elseLabel  = `if.else.${idx}`;
        const mergeLabel = `if.merge.${idx}`;

        const cmpReg = this.emitCondition(lines, expr.condition, varCtx);
        lines.push(`  br i1 ${cmpReg}, label %${thenLabel}, label %${elseLabel}`);

        // ── then arm ──
        lines.push('');
        lines.push(`${thenLabel}:`);
        this.currentLabel = thenLabel;
        const thenVal  = this.emitExpr(lines, expr.thenExpr, varCtx, expectedTy);
        const thenFrom = this.currentLabel; // may differ after a nested if-expr
        lines.push(`  br label %${mergeLabel}`);

        // ── else arm ──
        lines.push('');
        lines.push(`${elseLabel}:`);
        this.currentLabel = elseLabel;
        const elseVal  = this.emitExpr(lines, expr.elseExpr, varCtx, expectedTy);
        const elseFrom = this.currentLabel;
        lines.push(`  br label %${mergeLabel}`);

        // ── merge + phi ──
        lines.push('');
        lines.push(`${mergeLabel}:`);
        this.currentLabel = mergeLabel;

        const result = `%${this.tmpIdx++}`;
        lines.push(
            `  ${result} = phi ${toLLVM(expectedTy)}` +
            ` [ ${thenVal}, %${thenFrom} ], [ ${elseVal}, %${elseFrom} ]`
        );
        return result;
    }

    // ── Condition ─────────────────────────────────────────────────────────────

    private emitCondition(lines: string[], cond: Condition, varCtx: VarCtx): string {
        // ── Compound condition: &&, || (short-circuit) ─────────────────────────
        if (isBinaryCondition(cond)) {
            return this.emitBinaryCondition(lines, cond, varCtx);
        }

        // ── Leaf: BoolExprCondition — any Expression used as a bool ───────────
        //    Comparison operators are part of Expression (BinExprComp), so
        //    `a == b`, `x < 5`, `pred(val)`, `flag` all route through here.
        return this.emitBoolExprCondition(lines, cond as BoolExprCondition, varCtx);
    }

    /**
     * Emit a bool-returning expression used directly as a condition.
     *   `if pred(val) {`  →  emits pred(val) as i1
     *   `while isRunning() {`  →  same
     */
    private emitBoolExprCondition(lines: string[], cond: BoolExprCondition, varCtx: VarCtx): string {
        const ty  = this.inferType(cond.expr, varCtx);
        const val = this.emitExpr(lines, cond.expr, varCtx, ty);
        if (ty === 'i1') return val;
        // If a non-bool value slips through (e.g. int used as condition), truncate to i1.
        const r = `%${this.tmpIdx++}`;
        lines.push(`  ${r} = trunc ${toLLVM(ty)} ${val} to i1`);
        return r;
    }

    /**
     * Emit an array literal `[e1, e2, ...]` or `[]`.
     * Emits a `TypeArray.new()` call followed by one push per element.
     */
    private emitArrayLiteral(
        lines:      string[],
        expr:       ArrayLiteral,
        varCtx:     VarCtx,
        expectedTy: string,
    ): string {
        // Determine array type from expectedTy or first element
        let arrTy = expectedTy;
        if (!arrTy || arrTy === 'undef' || arrTy === 'void') {
            if (expr.elements.length > 0) {
                const elemTy = this.inferType(expr.elements[0], varCtx);
                arrTy = dynamicArrayLLVMType(toLLVM(elemTy));
            } else {
                arrTy = INTARRAY_TY;
            }
        }

        // Emit the constructor call
        const arrReg = `%${this.tmpIdx++}`;
        if (arrTy === INTARRAY_TY || arrTy === '%IntArray*') {
            if (!this.externTable.has('intarray_new')) this.usesIntArray = true;
            lines.push(`  ${arrReg} = call %IntArray* @intarray_new()`);
        } else if (arrTy === STRINGARRAY_TY || arrTy === '%StringArray*') {
            if (!this.externTable.has('stringarray_new')) this.usesStringArray = true;
            lines.push(`  ${arrReg} = call %StringArray* @stringarray_new()`);
        } else if (arrTy === NUMBERARRAY_TY) {
            if (!this.externTable.has('numberarray_new')) this.usesNumberArray = true;
            lines.push(`  ${arrReg} = call %NumberArray* @numberarray_new()`);
        } else if (arrTy === ANYARRAY_TY) {
            if (!this.externTable.has('anyarray_new')) this.usesAnyArray = true;
            lines.push(`  ${arrReg} = call %AnyArray* @anyarray_new()`);
        } else if (arrTy === BOOLARRAY_TY) {
            if (!this.externTable.has('boolarray_new')) this.usesBoolArray = true;
            lines.push(`  ${arrReg} = call %BoolArray* @boolarray_new()`);
        } else if (arrTy === PTRARRAY_TY) {
            if (!this.externTable.has('ptrarray_new')) this.usesPtrArray = true;
            lines.push(`  ${arrReg} = call %PtrArray* @ptrarray_new()`);
        } else if (arrTy === FLOATARRAY_TY) {
            if (!this.externTable.has('floatarray_new')) this.usesFloatArray = true;
            lines.push(`  ${arrReg} = call %FloatArray* @floatarray_new()`);
        } else if (arrTy === DOUBLEARRAY_TY) {
            if (!this.externTable.has('doublearray_new')) this.usesDoubleArray = true;
            lines.push(`  ${arrReg} = call %DoubleArray* @doublearray_new()`);
        } else if (arrTy === INTSET_TY) {
            if (!this.externTable.has('intset_new')) this.usesIntSet = true;
            lines.push(`  ${arrReg} = call %IntSet* @intset_new()`);
        } else if (arrTy === STRINGSET_TY) {
            if (!this.externTable.has('stringset_new')) this.usesStringSet = true;
            lines.push(`  ${arrReg} = call %StringSet* @stringset_new()`);
        } else if (arrTy === BOOLSET_TY) {
            if (!this.externTable.has('boolset_new')) this.usesBoolSet = true;
            lines.push(`  ${arrReg} = call %BoolSet* @boolset_new()`);
        } else if (arrTy === FLOATSET_TY) {
            if (!this.externTable.has('floatset_new')) this.usesFloatSet = true;
            lines.push(`  ${arrReg} = call %FloatSet* @floatset_new()`);
        } else if (arrTy === DOUBLESET_TY) {
            if (!this.externTable.has('doubleset_new')) this.usesDoubleSet = true;
            lines.push(`  ${arrReg} = call %DoubleSet* @doubleset_new()`);
        } else if (arrTy === NUMBERSET_TY) {
            if (!this.externTable.has('numberset_new')) this.usesNumberSet = true;
            lines.push(`  ${arrReg} = call %NumberSet* @numberset_new()`);
        } else {
            lines.push(`  ; WARNING: array literal in unknown context (expected=${arrTy}) — using intarray_new`);
            if (!this.externTable.has('intarray_new')) this.usesIntArray = true;
            lines.push(`  ${arrReg} = call %IntArray* @intarray_new()`);
            arrTy = INTARRAY_TY;
        }

        // Push each element
        if (expr.elements.length > 0) {
            // Determine element type and push function
            const { elemIRTy, pushFn } = ARRAY_PUSH_INFO[arrTy] ?? { elemIRTy: 'i32', pushFn: 'intarray_push' };
            for (const element of expr.elements) {
                const elemVal = this.emitExpr(lines, element, varCtx, elemIRTy);
                lines.push(`  call void @${pushFn}(${arrTy} ${arrReg}, ${elemIRTy} ${elemVal})`);
            }
        }

        return arrReg;
    }

    /**
     * Short-circuit `&&` / `||`.
     *
     * For `&&`:
     *   - evaluate left; if false jump straight to merge (result = false)
     *   - otherwise fall through to rhs block, evaluate right
     *   - merge: phi [ false, leftBlock ], [ rightResult, rightBlock ]
     *
     * For `||`:
     *   - evaluate left; if true jump straight to merge (result = true)
     *   - otherwise fall through to rhs block, evaluate right
     *   - merge: phi [ true, leftBlock ], [ rightResult, rightBlock ]
     */
    private emitBinaryCondition(
        lines:  string[],
        cond:   BinaryCondition,
        varCtx: VarCtx,
    ): string {
        const idx = this.ifIdx++;

        if (cond.op === '&&') {
            const rhsLabel   = `and.rhs.${idx}`;
            const mergeLabel = `and.merge.${idx}`;

            // Left side
            const leftReg   = this.emitCondition(lines, cond.left, varCtx);
            const leftBlock = this.currentLabel;
            lines.push(`  br i1 ${leftReg}, label %${rhsLabel}, label %${mergeLabel}`);

            // Right side (only reached when left is true)
            lines.push('');
            lines.push(`${rhsLabel}:`);
            this.currentLabel = rhsLabel;
            const rightReg   = this.emitCondition(lines, cond.right, varCtx);
            const rightBlock = this.currentLabel;
            lines.push(`  br label %${mergeLabel}`);

            // Merge
            lines.push('');
            lines.push(`${mergeLabel}:`);
            this.currentLabel = mergeLabel;
            const result = `%${this.tmpIdx++}`;
            lines.push(
                `  ${result} = phi i1 [ false, %${leftBlock} ], [ ${rightReg}, %${rightBlock} ]`,
            );
            return result;

        } else { // '||'
            const rhsLabel   = `or.rhs.${idx}`;
            const mergeLabel = `or.merge.${idx}`;

            // Left side
            const leftReg   = this.emitCondition(lines, cond.left, varCtx);
            const leftBlock = this.currentLabel;
            lines.push(`  br i1 ${leftReg}, label %${mergeLabel}, label %${rhsLabel}`);

            // Right side (only reached when left is false)
            lines.push('');
            lines.push(`${rhsLabel}:`);
            this.currentLabel = rhsLabel;
            const rightReg   = this.emitCondition(lines, cond.right, varCtx);
            const rightBlock = this.currentLabel;
            lines.push(`  br label %${mergeLabel}`);

            // Merge
            lines.push('');
            lines.push(`${mergeLabel}:`);
            this.currentLabel = mergeLabel;
            const result = `%${this.tmpIdx++}`;
            lines.push(
                `  ${result} = phi i1 [ true, %${leftBlock} ], [ ${rightReg}, %${rightBlock} ]`,
            );
            return result;
        }
    }

    // ── Member call statement ─────────────────────────────────────────────────

    /** `namespace.member(args)` as a statement. */
    private emitMemberCallStatement(
        lines:  string[],
        stmt:   MemberCallStatement,
        varCtx: VarCtx,
    ): void {
        const receiver = (stmt as any).selfCall ? 'self' : (stmt.namespace ?? 'undef');
        this.emitMemberCallInstr(lines, receiver, stmt.member, stmt.args, varCtx, false);
    }

    /**
     * Resolve `receiver.method(args)`:
     *
     *  1. If `receiver` is a local variable in scope → built-in type method
     *     (bool.toString / bool.toNumber / int.toFloat / etc.)
     *  2. If `receiver` is a NamespaceImport binding → module function call
     *     (the original behaviour)
     *
     * Returns the result register (or 'undef' / '' for void/unknown).
     */
    private emitMemberCallInstr(
        lines:     string[],
        receiver:  string,
        member:    string,
        args:      Expression[],
        varCtx:    VarCtx,
        capture:   boolean,
    ): string {
        // ── 1a. Extension method call (user-defined, takes priority) ──────────
        const varInfo = varCtx.get(receiver);
        if (varInfo) {
            // ── 1a-i. PtrArray built-in method (Array<StructType>) ─────────────
            // PtrArray has no extension methods in the extTable; handle directly.
            if (isPtrArrayTy(varInfo.llvmType)) {
                return this.emitPtrArrayMethod(lines, varInfo, member, args, varCtx, capture);
            }

            // ── 1a-ii. PtrMap built-in method (Map with struct key or value) ────
            if (isAnyPtrMapTy(varInfo.llvmType)) {
                return this.emitPtrMapMethod(lines, varInfo, member, args, varCtx, capture);
            }

            const extMethods = this.extTable.get(varInfo.llvmType);
            if (extMethods?.has(member)) {
                const entry = extMethods.get(member)!;
                return this.emitExtensionMethodCall(lines, varInfo, entry, member, args, varCtx, capture);
            }

            // ── 1b. Generic extension method call (for generic type receivers) ──
            const genInfo = this.mangledTypeIndex.get(varInfo.llvmType);
            if (genInfo) {
                const genMethods = this.genericExtIndex.get(genInfo.typeDecl.name);
                if (genMethods?.has(member)) {
                    const gEntry = genMethods.get(member)!;
                    return this.emitGenericExtensionMethodCall(
                        lines, varInfo, gEntry, member, args, varCtx, capture, genInfo.env,
                    );
                }
            }

            // ── 1b-ii. Generic enum inline method call (e.g. opt.isSome()) ──────────
            const enumGenInfo = this.mangledEnumTypeIndex.get(varInfo.llvmType);
            if (enumGenInfo) {
                // Find the EnumMethod by name inside the enum declaration
                const enumMethod = enumGenInfo.decl.members
                    .filter(isEnumMethod)
                    .find((m: EnumMethod) => m.name === member);
                if (enumMethod) {
                    return this.emitGenericEnumMethodCall(
                        lines, varInfo, enumMethod as EnumMethod, member, args, varCtx, capture, enumGenInfo.env,
                    );
                }
            }

            // ── 1c. Fat-pointer (fn-val) extension method (e.g. Function<A,R>.call) ─
            if (isFnValTy(varInfo.llvmType)) {
                const fnExt = this.fnValExtIndex.get(member);
                if (fnExt && varInfo.fnParamTypes && varInfo.fnReturnType && isTypeDeclaration(fnExt.typeDecl)) {
                    const typeEnv = buildTypeEnvFromFnAlias(
                        fnExt.typeDecl, varInfo.fnParamTypes, varInfo.fnReturnType,
                    );
                    // Build a descriptive mangled name: FunctionTypeName_A_R_method
                    const typeArgsSuffix = fnExt.typeParams
                        .map(p => llvmTypeToSuffix(typeEnv.get(p.name) ?? 'i8*'))
                        .join('_');
                    const mangledName = `${fnExt.typeDecl.name}_${typeArgsSuffix}_${member}`;
                    return this.emitGenericExtensionMethodCall(
                        lines, varInfo, fnExt, member, args, varCtx, capture, typeEnv, mangledName,
                    );
                }
            }

            // ── 1d. Built-in type method (fallback) ───────────────────────────
            const result = this.emitTypeMethod(lines, varInfo, member, args, varCtx);
            if (result !== null) return result;
        }

        // ── 2. Static extension method call: TypeName.staticMethod(args) ────────
        //
        // When `receiver` is not a local variable, check whether it is the name
        // of a type that has a static extension method named `member`.
        // Example: `String.new(5)` → receiver="String", member="new"
        const staticMethods = this.staticTable.get(receiver);
        if (staticMethods?.has(member)) {
            const entry = staticMethods.get(member)!;
            return this.emitStaticExtensionMethodCall(lines, entry, member, args, varCtx, capture);
        }

        // ── 3. Namespace import call ──────────────────────────────────────────
        const mod = this.nsTable.get(receiver);
        if (!mod) {
            lines.push(`  ; WARNING: '${receiver}' is neither a variable, a type with static method '${member}', nor a known namespace`);
            return 'undef';
        }
        // Try FunctionDeclaration first
        const fn = mod.program.elements
            .filter(isFunctionDeclaration)
            .find(f => f.name === member);
        if (fn) return this.emitCallInstrFn(lines, fn, args, varCtx, capture);

        // Then try ExternDeclaration
        const ext = mod.program.elements
            .filter(isExternDeclaration)
            .find(e => e.name === member);
        if (ext) return this.emitCallInstrExt(lines, ext, args, varCtx, capture);

        lines.push(`  ; WARNING: '${member}' not found in namespace '${receiver}'`);
        return 'undef';
    }

    // ── Field access ──────────────────────────────────────────────────────────
    //
    // Emit IR for `receiver.field` or `self.field`.
    // The receiver must be a variable whose LLVM type is `%TypeName*` (a struct pointer).
    // Emits: load the pointer, GEP to the field, load the field value.

    private emitFieldAccess(lines: string[], expr: FieldAccess, varCtx: VarCtx): string {
        const receiverName = expr.selfReceiver ? 'self' : (expr.receiver ?? '');
        const receiverInfo = varCtx.get(receiverName);
        if (!receiverInfo) {
            const fieldName = expr.field ?? '';

            // ── 1. Static property dispatch (highest priority) ──────────────────
            // `TypeName.PropName` declared as `export static PropName: T = expr;`
            // Lowered to a private zero-arg function `@TypeName_PropName()`.
            const propEntry = fieldName ? this.staticPropsTable.get(receiverName)?.get(fieldName) : undefined;
            if (propEntry) {
                const retTy       = resolveTypeRef(propEntry.property.type);
                const mangledName = `${propEntry.typeName}_${fieldName}`;
                const result      = `%${this.tmpIdx++}`;
                lines.push(`  ${result} = call ${toLLVM(retTy)} @${mangledName}()`);
                return result;
            }

            // ── 2. Zero-arg static method dispatch ──────────────────────────────
            // `TypeName.ConstantName` backed by `export static fn ConstantName(): T { ... }`
            const staticMethods = this.staticTable.get(receiverName);
            if (fieldName && staticMethods?.has(fieldName)) {
                const entry = staticMethods.get(fieldName)!;
                if (entry.method.parameters.length === 0) {
                    const retTy       = entry.method.returnType
                        ? resolveTypeRef(entry.method.returnType)
                        : 'void';
                    const mangledName = `${entry.typeName}_${fieldName}`;
                    const result      = `%${this.tmpIdx++}`;
                    lines.push(`  ${result} = call ${toLLVM(retTy)} @${mangledName}()`);
                    return result;
                }
            }
            lines.push(`  ; WARNING: unknown receiver '${receiverName}' in field access`);
            return 'undef';
        }

        const ptrTy  = receiverInfo.llvmType;   // e.g. "%Point*"
        const baseTy = ptrTy.replace(/\*$/, ''); // e.g. "%Point"
        const tn     = baseTy.replace(/^%/, ''); // e.g. "Point"

        const fields = this.structFieldMap.get(tn);
        if (!fields) {
            lines.push(`  ; WARNING: no field map for type '${tn}'`);
            return 'undef';
        }

        const fieldIdx = fields.findIndex(f => f.name === expr.field);
        if (fieldIdx < 0) {
            lines.push(`  ; WARNING: field '${expr.field}' not found in '${tn}'`);
            return 'undef';
        }

        const fieldInfo  = fields[fieldIdx];
        const fieldIrTy  = toLLVM(fieldInfo.llvmType);
        const fieldAlign = alignOf(fieldInfo.llvmType);

        // Load the struct pointer from its alloca
        const ptrVal = `%${this.tmpIdx++}`;
        lines.push(`  ${ptrVal} = load ${baseTy}*, ${baseTy}** ${receiverInfo.allocaName}, align 8`);

        // GEP to the field
        const gepResult = `%${this.tmpIdx++}`;
        lines.push(`  ${gepResult} = getelementptr inbounds ${baseTy}, ${baseTy}* ${ptrVal}, i32 0, i32 ${fieldIdx}`);

        // Load the field value
        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = load ${fieldIrTy}, ${fieldIrTy}* ${gepResult}, align ${fieldAlign}`);
        return result;
    }

    /**
     * Resolve the LLVM type of `receiverName.fieldName` using the struct field map.
     * Returns null if the receiver or field is not found.
     */
    private resolveFieldType(receiverName: string, fieldName: string, varCtx: VarCtx): string | null {
        const receiverInfo = varCtx.get(receiverName);
        if (!receiverInfo) return null;
        const ptrTy  = receiverInfo.llvmType;
        const baseTy = ptrTy.replace(/\*$/, '');
        const tn     = baseTy.replace(/^%/, '');
        const fields = this.structFieldMap.get(tn);
        if (!fields) return null;
        return fields.find(f => f.name === fieldName)?.llvmType ?? null;
    }

    /**
     * Emit a chained member call: `(self | ID).field.method(args)`.
     *
     * Strategy:
     *   1. Load the struct pointer from the receiver's alloca.
     *   2. GEP to the named field and load the field value.
     *   3. Synthesise a temporary VarInfo for the field value.
     *   4. Dispatch the method call through emitMemberCallInstr using the
     *      synthesised receiver name.
     *
     * `capture` controls whether the result is used (true = value context,
     * false = statement context).
     */
    private emitChainedMemberCall(
        lines:    string[],
        node:     ChainedMemberCallExpr | ChainedMemberCallStatement,
        varCtx:   VarCtx,
        capture:  boolean,
    ): string {
        const receiverName = node.selfCall ? 'self' : (node.namespace ?? '');
        const receiverInfo = varCtx.get(receiverName);
        if (!receiverInfo) {
            lines.push(`  ; WARNING: unknown receiver '${receiverName}' in chained call`);
            return 'undef';
        }

        const ptrTy  = receiverInfo.llvmType;
        const baseTy = ptrTy.replace(/\*$/, '');
        const tn     = baseTy.replace(/^%/, '');
        const fields = this.structFieldMap.get(tn);
        if (!fields) {
            lines.push(`  ; WARNING: no field map for '${tn}' in chained call`);
            return 'undef';
        }

        const fieldIdx = fields.findIndex(f => f.name === node.field);
        if (fieldIdx < 0) {
            lines.push(`  ; WARNING: field '${node.field}' not found in '${tn}'`);
            return 'undef';
        }

        const fieldInfo  = fields[fieldIdx];
        const fieldIrTy  = toLLVM(fieldInfo.llvmType);
        const fieldAlign = alignOf(fieldInfo.llvmType);

        // 1. Load struct pointer
        const ptrVal = `%${this.tmpIdx++}`;
        lines.push(`  ${ptrVal} = load ${baseTy}*, ${baseTy}** ${receiverInfo.allocaName}, align 8`);

        // 2. GEP to field
        const gepResult = `%${this.tmpIdx++}`;
        lines.push(`  ${gepResult} = getelementptr inbounds ${baseTy}, ${baseTy}* ${ptrVal}, i32 0, i32 ${fieldIdx}`);

        // 3. Load field value
        const fieldVal = `%${this.tmpIdx++}`;
        lines.push(`  ${fieldVal} = load ${fieldIrTy}, ${fieldIrTy}* ${gepResult}, align ${fieldAlign}`);

        // 4. Alloca a temp variable holding the field value so emitMemberCallInstr
        //    can load it via the standard allocaName + llvmType pattern.
        const tmpName = `__chain_${this.tmpIdx++}`;
        const tmpAlloca = `%${tmpName}`;
        lines.push(`  ${tmpAlloca} = alloca ${fieldIrTy}, align ${fieldAlign}`);
        lines.push(`  store ${fieldIrTy} ${fieldVal}, ${fieldIrTy}* ${tmpAlloca}, align ${fieldAlign}`);

        // Register the temp in varCtx for the duration of this call
        const savedEntry = varCtx.get(tmpName);
        varCtx.set(tmpName, { allocaName: tmpAlloca, llvmType: fieldInfo.llvmType });

        const result = this.emitMemberCallInstr(lines, tmpName, node.member, node.args, varCtx, capture);

        // Restore varCtx
        if (savedEntry === undefined) varCtx.delete(tmpName);
        else varCtx.set(tmpName, savedEntry);

        return result;
    }

    /**
     * Emit a postfix method-call chain: `expr.member(args)`.
     *
     * Handles arbitrary-depth chaining such as `arr.getSafe(i).unwrapOr(0)`:
     *   1. Recursively infer the LLVM type of `receiver`.
     *   2. Emit IR for `receiver` → SSA value.
     *   3. Alloca a temp slot, store the value, register in varCtx.
     *   4. Dispatch through emitMemberCallInstr (which handles extension
     *      methods, built-in type methods, generic dispatch, etc.).
     *   5. Clean up the temp varCtx entry.
     *
     * `capture` is true when the result is used as a value.
     */
    private emitPostfixCallExpr(
        lines:   string[],
        expr:    PostfixCallExpr,
        varCtx:  VarCtx,
        capture: boolean,
    ): string {
        // 1. Infer the LLVM type of the receiver expression
        const receiverTy = this.inferType(expr.receiver, varCtx);
        if (!receiverTy || receiverTy === 'void') {
            lines.push(`  ; WARNING: cannot infer receiver type for postfix call .${expr.member}()`);
            return 'undef';
        }

        // 2. Emit IR for the receiver — pass receiverTy as expectedTy so that
        //    e.g. getSafe() bitcasts its i8* result to the right struct pointer.
        const receiverVal = this.emitExpr(lines, expr.receiver, varCtx, receiverTy);
        if (receiverVal === 'undef') return 'undef';

        // 3. Alloca a temp slot and store the value so emitMemberCallInstr can
        //    load it via the standard allocaName + llvmType pattern.
        const tmpName   = `__pc_${this.tmpIdx++}`;
        const tmpAlloca = `%${tmpName}`;
        const irTy      = toLLVM(receiverTy);
        const align     = alignOf(receiverTy);
        lines.push(`  ${tmpAlloca} = alloca ${irTy}, align ${align}`);
        lines.push(`  store ${irTy} ${receiverVal}, ${irTy}* ${tmpAlloca}, align ${align}`);

        // Register in varCtx for the duration of the call
        const savedEntry = varCtx.get(tmpName);
        varCtx.set(tmpName, { allocaName: tmpAlloca, llvmType: receiverTy });

        // 4. Dispatch method call (handles extension, generic, built-in, namespace)
        const result = this.emitMemberCallInstr(lines, tmpName, expr.member, expr.args, varCtx, capture);

        // 5. Restore varCtx
        if (savedEntry === undefined) varCtx.delete(tmpName);
        else varCtx.set(tmpName, savedEntry);

        return result;
    }

    // ── Built-in type method dispatch ─────────────────────────────────────────

    /**
     * Emit LLVM IR for a built-in type method call.
     * Returns the result register, or `null` if the method is not known for
     * this type (so the caller can fall through to namespace resolution).
     *
     * Supported methods
     * ─────────────────
     *   bool  (i1)      .toString()  →  i8*   "true" | "false"
     *                   .toNumber()  →  i32   0 | 1
     *                   .not()       →  i1    logical negation
     *
     *   int   (i32)     .toFloat()   →  double  (signed int → double)
     *                   .toBool()    →  i1      (n != 0)
     *
     *   float (double)  .toInt()     →  i32   truncating cast
     *                   .toBool()    →  i1    (f != 0.0)
     */
    private emitTypeMethod(
        lines:   string[],
        info:    VarInfo,
        method:  string,
        args:    Expression[],
        varCtx:  VarCtx,
    ): string | null {
        switch (toLLVM(info.llvmType)) {
            case 'i1':     return this.emitBoolMethod  (lines, info, method);
            case 'i32':    return this.emitIntMethod   (lines, info, method);
            case 'double': return this.emitFloatMethod (lines, info, method);
            case 'i8*':    return this.emitStringMethod(lines, info, method, args, varCtx);
            default:       return null;
        }
    }

    /**
     * Built-in methods for `string` / `String` (i8*).
     *
     * These are always available without importing stdlib/string.
     * The implementation lowers directly to calls into runtime/string.c which
     * is always compiled and linked with every binary.
     *
     *   string  .length()    →  i32   UTF-8 character count (NOT raw byte count)
     *           .at(i)       →  i8*   single character at index `i` (negative: from end)
     *           .toString()  →  i8*   identity — returns the string itself
     */
    private emitStringMethod(
        lines:  string[],
        info:   VarInfo,
        method: string,
        args:   Expression[],
        varCtx: VarCtx,
    ): string | null {
        // Load the i8* pointer from the alloca.
        const load = (): string => {
            const v = `%${this.tmpIdx++}`;
            lines.push(`  ${v} = load i8*, i8** ${info.allocaName}, align 8`);
            return v;
        };

        switch (method) {
            case 'length': {
                this.usesStringBuiltins = true;
                const ptr = load();
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = call i32 @length(i8* ${ptr})`);
                return res;
            }
            case 'at': {
                if (args.length < 1) return null;
                this.usesStringBuiltins = true;
                const ptr = load();
                const idx = this.emitExpr(lines, args[0], varCtx, 'i32');
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = call i8* @at(i8* ${ptr}, i32 ${idx})`);
                return res;
            }
            case 'toString': {
                // Identity: string.toString() == self — just load the pointer.
                return load();
            }
            default:
                return null;
        }
    }

    /** Built-in methods for `bool` (i1). */
    private emitBoolMethod(lines: string[], info: VarInfo, method: string): string | null {
        if (method !== 'toString' && method !== 'toNumber' && method !== 'not') return null;

        // Load receiver
        const val = `%${this.tmpIdx++}`;
        lines.push(`  ${val} = load i1, i1* ${info.allocaName}, align 1`);

        switch (method) {
            case 'toString': {
                // select between pre-interned "true\0" and "false\0" constants
                const res      = `%${this.tmpIdx++}`;
                const trueGep  = this.rawStringGep('true');
                const falseGep = this.rawStringGep('false');
                lines.push(`  ${res} = select i1 ${val}, i8* ${trueGep}, i8* ${falseGep}`);
                return res;
            }
            case 'toNumber': {
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = zext i1 ${val} to i32`);
                return res;
            }
            case 'not': {
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = xor i1 ${val}, true`);
                return res;
            }
            default: return null;
        }
    }

    /** Built-in methods for `int` / `Int32` (i32). */
    private emitIntMethod(lines: string[], info: VarInfo, method: string): string | null {
        if (method !== 'toFloat' && method !== 'toBool'
            && method !== 'toString' && method !== 'length') return null;

        const val = `%${this.tmpIdx++}`;
        lines.push(`  ${val} = load i32, i32* ${info.allocaName}, align 4`);

        switch (method) {
            case 'toFloat': {
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = sitofp i32 ${val} to double`);
                return res;
            }
            case 'toBool': {
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = icmp ne i32 ${val}, 0`);
                return res;
            }
            case 'toString': {
                // int.toString() → int_to_string(n): i8*
                this.usesIntToString = true;
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = call i8* @int_to_string(i32 ${val})`);
                return res;
            }
            case 'length': {
                // int.length() → number of decimal digits (e.g. 0→1, 10→2, -5→2)
                this.usesIntDigitCount = true;
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = call i32 @int_digit_count(i32 ${val})`);
                return res;
            }
            default: return null;
        }
    }

    /** Built-in methods for `float` / `Float64` / `Number` (double). */
    private emitFloatMethod(lines: string[], info: VarInfo, method: string): string | null {
        if (method !== 'toInt' && method !== 'toBool' && method !== 'toString') return null;

        const val = `%${this.tmpIdx++}`;
        lines.push(`  ${val} = load double, double* ${info.allocaName}, align 8`);

        switch (method) {
            case 'toInt': {
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = fptosi double ${val} to i32`);
                return res;
            }
            case 'toBool': {
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = fcmp one double ${val}, 0.0`);
                return res;
            }
            case 'toString': {
                // float.toString() → float_to_string(f): i8*
                this.usesFloatToString = true;
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = call i8* @float_to_string(double ${val})`);
                return res;
            }
            default: return null;
        }
    }

    private emitCallInstr(
        lines:         string[],
        callee:        string,
        args:          Expression[],
        varCtx:        VarCtx,
        capture:       boolean,
        isTailCall:    boolean = false,
        expectedTy?:   string,
        callTypeArgs?: TypeReference[],
    ): string {
        // ── Indirect call through a function-type variable ────────────────────
        const fnVarInfo = varCtx.get(callee);
        if (fnVarInfo && isFnValTy(fnVarInfo.llvmType)) {
            return this.emitIndirectCallInstr(lines, callee, args, varCtx, fnVarInfo, capture, expectedTy);
        }

        // ── Local (nested) function scope ─────────────────────────────────────
        const localEntry = this.localFnScope.get(callee);
        if (localEntry) {
            return this.emitCallInstrFn(
                lines, localEntry.fn, args, varCtx, capture,
                isTailCall, expectedTy, callTypeArgs, localEntry.mangledName,
            );
        }
        // Forward-reference check: callee is a local fn declared later in the block
        if (this.blockLocalFnNames.has(callee) && !this.localFnScope.has(callee)) {
            throw new Error(
                `Forward reference: '${callee}' is called before it is declared. ` +
                `Move the 'fn ${callee}' declaration above the call.`
            );
        }

        // ── Built-in I/O functions ────────────────────────────────────────────
        //
        //   write(s)     printf("%s", s)   — output string without newline
        //   flush()      fflush(NULL)      — flush all stdio buffers
        //   readLine()   codelang_readline() — read one line from stdin
        //   readAll()    codelang_readall()  — read all stdin until EOF
        //
        // These are intercepted here so they work even when stdlib/io.code is
        // not imported (write/flush are the most common case).
        if (callee === 'write' && args.length === 1) {
            return this.emitWriteBuiltin(lines, args[0], varCtx, capture);
        }
        if (callee === 'flush' && args.length === 0) {
            if (!this.externTable.has('fflush')) this.needsFflushDecl = true;
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i32 @fflush(i8* null)`);
            return capture ? tmp : 'void';
        }
        if (callee === 'readLine' && args.length === 0) {
            if (!this.externTable.has('codelang_readline')) this.needsReadLineDecl = true;
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i8* @codelang_readline()`);
            return capture ? tmp : 'void';
        }
        if (callee === 'readAll' && args.length === 0) {
            if (!this.externTable.has('codelang_readall')) this.needsReadAllDecl = true;
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i8* @codelang_readall()`);
            return capture ? tmp : 'void';
        }

        const fn = this.fnTable.get(callee);
        if (fn) return this.emitCallInstrFn(lines, fn, args, varCtx, capture, isTailCall, expectedTy, callTypeArgs);

        const ext = this.externTable.get(callee);
        if (ext) return this.emitCallInstrExt(lines, ext, args, varCtx, capture);

        // Auto-generated struct constructor: TypeName_new(field0, field1, ...)
        // Not used for types with an explicit `static fn new()` (they own that symbol).
        // Fixed-size array fields are excluded from the parameter list (they are
        // initialised inline from their compile-time values, not passed at the call site).
        if (callee.endsWith('_new')) {
            const typeName   = callee.slice(0, -4);  // strip '_new'
            const allFields  = this.structFieldMap.get(typeName);
            if (allFields && !this.structsWithExplicitNew.has(typeName)) {
                const paramFields = allFields.filter(f => !f.isFixedArray);
                return this.emitStructConstructorCall(lines, typeName, paramFields, args, varCtx);
            }
        }

        // ── Callable struct: TypeName(args) → @TypeName_call(args) ────────────
        // When a struct type declares a CallableMethod named `call` (or a
        // `static fn call`), invoking the type name directly desugars to that method.
        //
        //   type MyType extends Callable<int, int> {
        //     call(n: int): int { return n * 2; }
        //   }
        //   const x = MyType(500);  →  %x = call i32 @MyType_call(i32 500)
        if (this.callableStructs.has(callee)) {
            const typeDecl = this.structTypeDecls.get(callee);
            if (typeDecl) {
                const body = typeDecl.body as StructBody;
                const callMember = body.members.find(m =>
                    (isCallableMethod(m) && (m as CallableMethod).name === 'call') ||
                    (isStructMethod(m)   && (m as StructMethod).name  === 'call' && (m as StructMethod).static),
                ) as (CallableMethod | StructMethod) | undefined;

                if (callMember) {
                    const params   = callMember.parameters;
                    const retTyRef = callMember.returnType;
                    const retTy    = retTyRef ? resolveTypeRefWithEnv(retTyRef, EMPTY_ENV) : 'void';
                    const retIrTy  = toLLVM(retTy);

                    // Emit each argument expression with the expected parameter type
                    const argParts: string[] = [];
                    for (let i = 0; i < args.length; i++) {
                        const p      = params[i];
                        const pTy    = p?.type ? resolveTypeRefWithEnv(p.type, EMPTY_ENV) : undefined;
                        const pIrTy  = pTy ? toLLVM(pTy) : 'i32';
                        const aReg   = this.emitExpr(lines, args[i], varCtx, pTy ?? 'i32');
                        argParts.push(`${pIrTy} ${aReg}`);
                    }

                    const mangledName = `${callee}_call`;
                    const argStr = argParts.join(', ');

                    if (retIrTy === 'void' || !capture) {
                        lines.push(`  call ${retIrTy} @${mangledName}(${argStr})`);
                        return 'undef';
                    }
                    const ret = `%${this.tmpIdx++}`;
                    lines.push(`  ${ret} = call ${retIrTy} @${mangledName}(${argStr})`);
                    return ret;
                }
            }
        }

        lines.push(`  ; WARNING: call to unknown function '${callee}' — skipped`);
        return 'undef';
    }

    /** Emit a call to an auto-generated struct constructor `@TypeName_new`. */
    private emitStructConstructorCall(
        lines:    string[],
        typeName: string,
        fields:   Array<{ name: string; llvmType: string }>,
        args:     Expression[],
        varCtx:   VarCtx,
    ): string {
        const ptrTy = `%${typeName}*`;
        const argStr = fields
            .map((f, i) => {
                const irTy   = toLLVM(f.llvmType);
                const rawStr = f.llvmType === 'i8*';
                const val    = i < args.length
                    ? this.emitExpr(lines, args[i], varCtx, f.llvmType, rawStr)
                    : 'undef';
                return `${irTy} ${val}`;
            })
            .join(', ');
        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = call ${ptrTy} @${typeName}_new(${argStr})`);
        return result;
    }

    /**
     * Emit a struct literal expression: `Self { field: value, ... }` or
     * `TypeName { field: value, ... }`.
     *
     * Allocates heap memory (sizeof trick), then stores each field value.
     * `Self` is resolved to the current struct context (`currentStructContext`).
     */
    private emitStructLiteral(lines: string[], expr: StructLiteral, varCtx: VarCtx): string {
        // `typeName` is undefined when `selfLiteral` is set (i.e. `Self { ... }`)
        let typeName = (expr as any).selfLiteral
            ? (this.currentStructContext ?? 'Self')
            : (expr.typeName ?? 'Self');
        if (typeName === 'Self') {
            typeName = this.currentStructContext ?? typeName;
        }
        const fields = this.structFieldMap.get(typeName);
        if (!fields) {
            lines.push(`  ; WARNING: unknown struct type '${typeName}' in struct literal`);
            return 'undef';
        }

        const ptrTy  = `%${typeName}*`;
        const baseTy = `%${typeName}`;

        // Allocate heap memory for the new struct instance
        const sizePtr = `%${this.tmpIdx++}`;
        const sizeReg = `%${this.tmpIdx++}`;
        const rawReg  = `%${this.tmpIdx++}`;
        const newPtr  = `%${this.tmpIdx++}`;
        lines.push(`  ${sizePtr} = getelementptr ${baseTy}, ${ptrTy} null, i32 1`);
        lines.push(`  ${sizeReg} = ptrtoint ${ptrTy} ${sizePtr} to i64`);
        lines.push(`  ${rawReg}  = call i8* @malloc(i64 ${sizeReg})`);
        lines.push(`  ${newPtr}  = bitcast i8* ${rawReg} to ${ptrTy}`);

        // Partition into named/shorthand inits and spread sources.
        //   Self { x: 1, ...base }  → namedFields=[{x:1}], spreadSources=["base"]
        //   Self { name, stacktrace } → namedFields=[{shorthand:"name"},{shorthand:"stacktrace"}]
        const namedFields   = expr.fields.filter((fi: StructFieldInit) => fi.source === undefined);
        const spreadSources = expr.fields
            .filter((fi: StructFieldInit) => fi.source !== undefined)
            .map((fi: StructFieldInit) => fi.source as string);


        // Store each field — priority: explicit named/shorthand > spread > fixed-array default > undef.
        for (let i = 0; i < fields.length; i++) {
            const fieldDef  = fields[i];
            const irTy      = toLLVM(fieldDef.llvmType);
            const align     = alignOf(fieldDef.llvmType);
            const fptr      = `%${this.tmpIdx++}`;
            // Find either a named init (field: expr) or a shorthand init (field,)
            const initField = namedFields.find((fi: StructFieldInit) =>
                fi.name === fieldDef.name || (fi as any).shorthand === fieldDef.name
            );
            lines.push(`  ${fptr} = getelementptr inbounds ${baseTy}, ${ptrTy} ${newPtr}, i32 0, i32 ${i}`);

            let val: string;
            if (initField) {
                const shorthand = (initField as any).shorthand as string | undefined;
                if (shorthand) {
                    // Shorthand `fieldName,` — load the variable of the same name from varCtx
                    const varInfo = varCtx.get(shorthand);
                    if (!varInfo) {
                        throw new Error(
                            `Struct literal shorthand '${shorthand},': no variable named '${shorthand}' in scope`
                        );
                    }
                    const tmp = `%${this.tmpIdx++}`;
                    lines.push(`  ${tmp} = load ${toLLVM(varInfo.llvmType)}, ${ptrOf(varInfo.llvmType)} ${varInfo.allocaName}, align ${alignOf(varInfo.llvmType)}`);
                    val = tmp;
                } else {
                    val = this.emitExpr(lines, initField.value!, varCtx, fieldDef.llvmType);
                }
            } else {
                const spreadVal = spreadSources.length > 0
                    ? this.resolveFieldFromSpreads(lines, spreadSources, fieldDef, varCtx)
                    : null;
                if (spreadVal !== null) {
                    val = spreadVal;
                } else if (fieldDef.isFixedArray) {
                    const nElems = fieldDef.arraySize ?? 0;
                    const elemTy = irTy.match(/^\[(\d+) x (.+)\]$/)?.[2] ?? 'i32';
                    val = (fieldDef.arrayInitValues && fieldDef.arrayInitValues.length === nElems)
                        ? `[${fieldDef.arrayInitValues.map(v => `${elemTy} ${v}`).join(', ')}]`
                        : 'zeroinitializer';
                } else if (fieldDef.defaultValue) {
                    // Field has a scalar default value (e.g. `x: int = 0`)
                    val = this.emitExpr(lines, fieldDef.defaultValue, varCtx, fieldDef.llvmType);
                } else {
                    // No default: field is required — fail loudly at compile time.
                    throw new Error(
                        `Struct literal '${typeName} { ... }': required field '${fieldDef.name}' was not provided and has no default value`
                    );
                }
            }
            lines.push(`  store ${irTy} ${val}, ${irTy}* ${fptr}, align ${align}`);
        }
        return newPtr;
    }

    /**
     * Try to fill a struct field from one of the spread sources.
     *
     * Two cases:
     *   1. The target field is `_parent` and the spread variable's LLVM type matches →
     *      load + store the value directly (wraps an intrinsic/alias parent).
     *   2. The spread source is a known struct with a field of the same name →
     *      GEP into the source struct and load that field.
     *
     * Returns null when no spread source can supply the field.
     */
    private resolveFieldFromSpreads(
        lines:    string[],
        sources:  string[],
        fieldDef: { name: string; llvmType: string },
        varCtx:   VarCtx,
    ): string | null {
        for (const src of sources) {
            const srcInfo = varCtx.get(src);
            if (!srcInfo) continue;

            const srcIrTy = toLLVM(srcInfo.llvmType);

            // Case 1: target is the implicit _parent field, types must match
            if (fieldDef.name === '_parent' && srcIrTy === toLLVM(fieldDef.llvmType)) {
                const loaded = `%${this.tmpIdx++}`;
                lines.push(`  ${loaded} = load ${srcIrTy}, ${ptrOf(srcInfo.llvmType)} ${srcInfo.allocaName}, align ${alignOf(srcInfo.llvmType)}`);
                return loaded;
            }

            // Case 2: spread source is a known struct — match field by name
            const srcStructName = srcIrTy.match(/^%(.+)\*$/)?.[1];
            if (!srcStructName || !this.structFieldMap.has(srcStructName)) continue;

            const srcFields   = this.structFieldMap.get(srcStructName)!;
            const srcFieldIdx = srcFields.findIndex(f => f.name === fieldDef.name);
            if (srcFieldIdx === -1) continue;

            const srcField      = srcFields[srcFieldIdx];
            const srcFieldIrTy  = toLLVM(srcField.llvmType);
            const srcFieldAlign = alignOf(srcField.llvmType);

            const structPtr = `%${this.tmpIdx++}`;
            lines.push(`  ${structPtr} = load ${srcIrTy}, ${ptrOf(srcInfo.llvmType)} ${srcInfo.allocaName}, align 8`);

            const fieldPtr = `%${this.tmpIdx++}`;
            lines.push(`  ${fieldPtr} = getelementptr inbounds %${srcStructName}, ${srcIrTy} ${structPtr}, i32 0, i32 ${srcFieldIdx}`);

            const fieldVal = `%${this.tmpIdx++}`;
            lines.push(`  ${fieldVal} = load ${srcFieldIrTy}, ${srcFieldIrTy}* ${fieldPtr}, align ${srcFieldAlign}`);
            return fieldVal;
        }
        return null;
    }

    // ── Super call dispatch ───────────────────────────────────────────────────

    /**
     * Emit a `super.method(args)` call expression.
     *
     * Dispatch strategy (in priority order):
     *   1. Static method — look up in `staticTable` under the parent type name.
     *   2. Instance method — load the `_parent` field from `self` and dispatch
     *      through `emitMemberCallInstr` using a temporary VarCtx entry.
     *   3. Fallback — emit a direct `call @ParentType_method(args)` by mangled
     *      name; return type defaults to `%ParentType*` for `new`, else void.
     *
     * `currentParentType` must be non-null (set during struct method emission).
     */
    private emitSuperCallExpr(
        lines:      string[],
        expr:       SuperCallExpression,
        varCtx:     VarCtx,
        expectedTy?: string,
    ): string {
        const parentName = this.currentParentType;
        if (!parentName) {
            lines.push(`  ; ERROR: super.${expr.member}() used outside a type with a parent`);
            return 'undef';
        }

        // ── 1. Static method (e.g. super.new(args)) ──────────────────────────
        const staticMethods = this.staticTable.get(parentName);
        if (staticMethods?.has(expr.member)) {
            const entry = staticMethods.get(expr.member)!;
            return this.emitStaticExtensionMethodCall(lines, entry, expr.member, expr.args, varCtx, expectedTy !== undefined);
        }

        // ── 2. Instance method via _parent field ──────────────────────────────
        const selfInfo = varCtx.get('self');
        if (selfInfo) {
            const selfTy   = selfInfo.llvmType;
            const baseName = selfTy.replace(/^%/, '').replace(/\*$/, '');
            const fields   = this.structFieldMap.get(baseName);
            const pIdx     = fields?.findIndex(f => f.name === '_parent') ?? -1;
            if (pIdx >= 0) {
                const parentFieldTy = toLLVM(fields![pIdx].llvmType);
                const extMethods    = this.extTable.get(fields![pIdx].llvmType);
                if (extMethods?.has(expr.member)) {
                    const selfPtr = `%${this.tmpIdx++}`;
                    lines.push(`  ${selfPtr} = load ${selfTy}, ${ptrOf(selfInfo.llvmType)} ${selfInfo.allocaName}, align 8`);
                    const parentGep = `%${this.tmpIdx++}`;
                    lines.push(`  ${parentGep} = getelementptr inbounds %${baseName}, ${selfTy} ${selfPtr}, i32 0, i32 ${pIdx}`);
                    const parentVal = `%${this.tmpIdx++}`;
                    lines.push(`  ${parentVal} = load ${parentFieldTy}, ${parentFieldTy}* ${parentGep}, align 8`);
                    // Alloca a temp slot so emitMemberCallInstr can load from it
                    const tmpName   = `__super_tmp_${this.tmpIdx}`;
                    const tmpAlloca = `%${tmpName}`;
                    lines.push(`  ${tmpAlloca} = alloca ${parentFieldTy}, align 8`);
                    lines.push(`  store ${parentFieldTy} ${parentVal}, ${parentFieldTy}* ${tmpAlloca}, align 8`);
                    varCtx.set(tmpName, { allocaName: tmpAlloca, llvmType: fields![pIdx].llvmType });
                    const result = this.emitMemberCallInstr(lines, tmpName, expr.member, expr.args, varCtx, expectedTy !== undefined);
                    varCtx.delete(tmpName);
                    return result;
                }
            }
        }

        // ── 3. Direct mangled-name fallback ────────────────────────────────
        const mangledName = `${parentName}_${expr.member}`;
        const retTy       = expectedTy ?? (expr.member === 'new' ? `%${parentName}*` : 'void');
        const retLlvmTy   = toLLVM(retTy);

        const argParts: string[] = [];
        for (const arg of expr.args) {
            const argTy  = this.inferType(arg, varCtx);
            const argVal = this.emitExpr(lines, arg, varCtx, argTy);
            argParts.push(`${toLLVM(argTy)} ${argVal}`);
        }

        if (retLlvmTy === 'void') {
            lines.push(`  call void @${mangledName}(${argParts.join(', ')})`);
            return 'void';
        }
        const resultReg = `%${this.tmpIdx++}`;
        lines.push(`  ${resultReg} = call ${retLlvmTy} @${mangledName}(${argParts.join(', ')})`);
        return resultReg;
    }

    /**
     * Core call emission — shared by direct calls and namespace calls.
     *
     * When `isTailCall` is true (the call is in tail position):
     *   • `const fn`   → `musttail call`  (LLVM must eliminate the stack frame)
     *   • regular `fn` → `tail call`      (hint; optimizer may apply TCO at -O2)
     *
     * `musttail` requires that callee and caller return types agree.  We check
     * this before emitting so we never produce invalid IR.
     */
    private emitCallInstrFn(
        lines:         string[],
        fn:            FunctionDeclaration,
        args:          Expression[],
        varCtx:        VarCtx,
        capture:       boolean,
        isTailCall:    boolean = false,
        expectedTy?:   string,
        callTypeArgs?: TypeReference[],
        /** Override the LLVM symbol name — used for nested/local functions. */
        mangledName?:  string,
    ): string {
        // Check if this is a generic function
        const typeParams: TypeParam[] = (fn as any).typeParams ?? [];
        if (typeParams.length > 0) {
            return this.emitGenericCallInstrFn(lines, fn, typeParams, args, varCtx, capture, isTailCall, expectedTy, callTypeArgs);
        }

        const irName = mangledName ?? fn.name;

        // If the function has a type annotation (e.g. `fn compose: ComposeFn`), use its
        // parameter types for any param that lacks an explicit type declaration.
        const fnTypeAnnotation = (fn as any).typeAnnotation as TypeReference | undefined;
        const annotationFnRef  = fnTypeAnnotation ? resolveFnTypeRef(fnTypeAnnotation) : null;
        const annotationParams: any[] = annotationFnRef ? ((annotationFnRef as any).fnParams ?? []) : [];

        const retTy  = this.resolveReturnType(fn, this.prePassVarCtx(fn));
        const argStr = fn.parameters
            .map((p, i) => {
                let ty = resolveParamType(p);
                // If this parameter has no explicit type, check the type annotation
                if (!p.type && i < annotationParams.length && annotationParams[i]?.type) {
                    ty = resolveTypeRefWithEnv(annotationParams[i].type as TypeReference, EMPTY_ENV);
                }
                // Use raw (no-\n) string constants for function call arguments
                const rawStr = ty === 'i8*';
                let val: string;
                if (i < args.length) {
                    val = this.emitExpr(lines, args[i], varCtx, ty, rawStr);
                } else if (p.defaultValue) {
                    // Caller omitted this argument — emit the default value expression
                    // at the call site (call-site evaluation, like C++).
                    val = this.emitExpr(lines, p.defaultValue, varCtx, ty, rawStr);
                } else {
                    val = 'undef';
                }
                return `${toLLVM(ty)} ${val}`;
            })
            .join(', ');

        // Choose the call keyword:
        //   musttail → guaranteed stack-frame reuse (requires same return type)
        //   tail     → best-effort hint to the optimizer
        //   (plain)  → no TCO annotation
        let callKw = 'call';
        if (isTailCall) {
            const typesMatch = retTy === this.currentFnRetTy;
            callKw = (this.currentFnIsConst && typesMatch) ? 'musttail call' : 'tail call';
        }

        const irRetTy = toLLVM(retTy);
        if (retTy === 'void') {
            lines.push(`  ${callKw} void @${irName}(${argStr})`);
            return '';
        }

        const tmp = `%${this.tmpIdx++}`;
        lines.push(`  ${tmp} = ${callKw} ${irRetTy} @${irName}(${argStr})`);
        if (!capture) lines.push(`  ; result of @${irName} discarded`);
        return tmp;
    }

    /**
     * Emit a call to a generic function by inferring type arguments from the
     * actual argument types, mangling the name, and queuing a specialization.
     *
     * `callTypeArgs`  — explicit type arguments from the call site (e.g. `cast<string>(x)`)
     * `expectedTy`    — the LLVM type the caller expects the result to have (for return-type
     *                   inference when T only appears in the return position)
     */
    private emitGenericCallInstrFn(
        lines:         string[],
        fn:            FunctionDeclaration,
        typeParams:    TypeParam[],
        args:          Expression[],
        varCtx:        VarCtx,
        capture:       boolean,
        isTailCall:    boolean,
        expectedTy?:   string,
        callTypeArgs?: TypeReference[],
    ): string {
        // ── 0. Explicit type arguments take highest priority ─────────────────────
        // e.g. cast<string>(anyVal) or typeInfo<MyColor>()
        const env = new Map<string, string>();
        if (callTypeArgs && callTypeArgs.length > 0) {
            for (let i = 0; i < typeParams.length && i < callTypeArgs.length; i++) {
                const resolvedTy = resolveTypeRef(callTypeArgs[i]);
                env.set(typeParams[i].name, resolvedTy);
            }
        }

        // ── 1. Infer remaining type arguments from actual argument types ─────────
        for (let i = 0; i < fn.parameters.length && i < args.length; i++) {
            const param = fn.parameters[i];
            if (!param.type) continue;
            const pt = param.type as any;
            if (pt.ref && !(pt.ref as any).ref) {
                // param type is a bare type-param name (e.g. `x: T`)
                const pName = pt.ref.$refText as string | undefined;
                if (pName && !env.has(pName)) {
                    env.set(pName, this.inferType(args[i], varCtx));
                }
            } else if (pt.fnType) {
                // fn-typed param (e.g. `f: fn(A): R`) — extract A, R from the arg
                this.inferTypeParamsFromFnArg(pt, args[i], varCtx, env);
            }
        }

        // ── 2. If return type is a bare type param, infer from expected/current type
        if (fn.returnType && !fn.returnType.ref?.ref) {
            const rName = (fn.returnType.ref as any)?.$refText as string | undefined;
            if (rName && !env.has(rName)) {
                // Prefer expectedTy (from variable declaration context) over currentFnRetTy
                const inferFrom = (expectedTy && expectedTy !== 'void') ? expectedTy
                    : (this.currentFnRetTy && this.currentFnRetTy !== 'void') ? this.currentFnRetTy
                    : undefined;
                if (inferFrom) env.set(rName, inferFrom);
            }
        }

        // ── 3. Compiler intrinsics — handled in-place, no specialization queued ──
        // These generic functions are fully resolved at call-site.
        if (fn.name === 'typeInfo')   return this.emitTypeInfoIntrinsic(lines, args, varCtx, env, callTypeArgs);
        if (fn.name === 'cast')       return this.emitCastIntrinsic(lines, args, varCtx, env);
        if (fn.name === 'addressOf')  return this.emitAddressOfIntrinsic(lines, args, varCtx, env);
        if (fn.name === 'typeAddress') return this.emitTypeAddressIntrinsic(lines, args, varCtx, env, callTypeArgs);

        // Build mangled name suffix from typeParams declaration order
        const suffixes = typeParams.map(p => llvmTypeToSuffix(env.get(p.name) ?? 'i8*'));
        const mangledName = `${fn.name}_${suffixes.join('_')}`;

        // Queue specialization for emission
        if (!this.emittedSpecializations.has(mangledName) && !this.pendingSpecializations.has(mangledName)) {
            this.pendingSpecializations.set(mangledName, { fn, env });
        }

        // Resolve return type with env
        const retTy = fn.returnType
            ? resolveTypeRefWithEnv(fn.returnType, env)
            : (() => {
                // Try to infer from body with env-resolved param types
                for (const stmt of fn.body.statements) {
                    if (isReturnStatement(stmt) && stmt.value) {
                        const preCtx: VarCtx = new Map();
                        for (const p of fn.parameters) {
                            preCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: resolveTypeRefWithEnv(p.type, env) });
                        }
                        return this.inferType(stmt.value, preCtx);
                    }
                }
                return 'void';
            })();

        // Emit argument values using env to resolve param types
        const argStr = fn.parameters
            .map((p, i) => {
                const ty     = resolveTypeRefWithEnv(p.type, env);
                const rawStr = ty === 'i8*';
                const val    = i < args.length
                    ? this.emitExpr(lines, args[i], varCtx, ty, rawStr)
                    : 'undef';
                return `${toLLVM(ty)} ${val}`;
            })
            .join(', ');

        let callKw = 'call';
        if (isTailCall) {
            const typesMatch = retTy === this.currentFnRetTy;
            callKw = (this.currentFnIsConst && typesMatch) ? 'musttail call' : 'tail call';
        }

        const irRetTy = toLLVM(retTy);
        if (retTy === 'void') {
            lines.push(`  ${callKw} void @${mangledName}(${argStr})`);
            return '';
        }

        const tmp = `%${this.tmpIdx++}`;
        lines.push(`  ${tmp} = ${callKw} ${irRetTy} @${mangledName}(${argStr})`);
        if (!capture) lines.push(`  ; result of @${mangledName} discarded`);
        return tmp;
    }

    // ── Compiler-intrinsic generic functions ──────────────────────────────────
    //
    // These two functions are intercepted at every call-site in
    // emitGenericCallInstrFn and emit inline IR without queuing a generic
    // specialization.  The placeholder bodies in stdlib/reflection.code and
    // stdlib/any.code are therefore never compiled.

    /**
     * typeInfo<T>(value: T): TypeInfo
     *
     * Emits compile-time TypeInfo metadata for the resolved type T:
     *   • Calls @fieldarray_new() to start an empty FieldArray
     *   • For struct types: pushes one Field entry per declared field
     *   • Calls @typeinfo_new(name, fields) to assemble the TypeInfo
     *
     * When the call site provides explicit typeArgs (e.g. typeInfo<MyColor>()),
     * the TypeDeclaration is available and gives the exact CodeLang name.
     * Without explicit args, the name is derived from the LLVM type string.
     */
    private emitTypeInfoIntrinsic(
        lines:        string[],
        args:         Expression[],
        varCtx:       VarCtx,
        env:          Map<string, string>,
        callTypeArgs?: TypeReference[],
    ): string {
        // ── Determine type name and optional struct fields/methods ───────────
        let typeName = 'unknown';
        let structFields: Array<{
            name: string; llvmType: string;
            readonly?: boolean; constType?: boolean; isDisposable?: boolean;
            isFixedArray?: boolean; arraySize?: number; arrayInitValues?: number[];
        }> | undefined;
        let structMethods: Array<{
            name: string; isExportable: boolean; isConst: boolean; returnType: string;
        }> | undefined;

        // Prefer explicit type arg: typeInfo<MyColor>()
        const explicitTypeRef  = callTypeArgs?.[0];
        const explicitTypeDecl = explicitTypeRef?.ref?.ref as TypeDeclaration | undefined;
        if (explicitTypeDecl) {
            typeName      = explicitTypeDecl.name;
            structFields  = this.structFieldMap.get(typeName);
            structMethods = this.structMethodMetaMap.get(typeName);
        } else {
            // Fall back to inferred LLVM type.
            // When the explicit type arg is a type-param reference (e.g. typeInfo<T>()
            // inside a generic fn), resolveTypeRef returns i8* because it has no env.
            // Recover the actual concrete type by looking up the param name in the
            // current function's type environment, which holds T → i32/i8*/i1/etc.
            const paramName = (explicitTypeRef?.ref as any)?.$refText as string | undefined;
            const llvmTy = (paramName && this.currentTypeEnv.get(paramName))
                ?? env.get('T') ?? 'i8*';
            typeName      = llvmTypeToReadableName(llvmTy);
            // For struct types (e.g. %Foo*) try to look up fields/methods
            const m = llvmTy.match(/^%(.+)\*$/);
            if (m) {
                structFields  = this.structFieldMap.get(m[1]);
                structMethods = this.structMethodMetaMap.get(m[1]);
            }
        }

        // ── Emit: ptrarray_new() — Array<Field> backing ─────────────────────
        // FieldArray is now Array<Field> → %PtrArray* at the LLVM level.
        // We use the shared ptrarray_new / ptrarray_push runtime functions.
        const fieldArrayReg = `%${this.tmpIdx++}`;
        lines.push(`  ${fieldArrayReg} = call %PtrArray* @ptrarray_new()`);
        this.usesPtrArray = true;  // ensure PtrArray decls are emitted

        // ── Helper: intern strings and emit a field_new + ptrarray_push ──────
        //
        // @field_new signature (10 params):
        //   (i8* name, i8* typeName,
        //    i32 isProperty, i32 isExportable, i32 isFunction,
        //    i32 isDisposable, i32 isConst, i8* returnType,
        //    i32 isInitialized, i8* initialValue): %Field*
        // Then push via ptrarray_push with a bitcast %Field* → i8*.
        const emitFieldEntry = (
            name:          string,
            typeNameStr:   string,
            isProperty:    0 | 1,
            isExportable:  0 | 1,
            isFunction:    0 | 1,
            isDisposable:  0 | 1,
            isConst:       0 | 1,
            returnType:    string,
            isInitialized: 0 | 1,
            initialValue:  string,
        ): void => {
            this.rawInternString(name);
            this.rawInternString(typeNameStr);
            this.rawInternString(returnType);
            this.rawInternString(initialValue);
            const nameGep         = this.rawStringGep(name);
            const typeNameGep     = this.rawStringGep(typeNameStr);
            const returnTypeGep   = this.rawStringGep(returnType);
            const initialValueGep = this.rawStringGep(initialValue);
            const fieldReg  = `%${this.tmpIdx++}`;
            const castReg   = `%${this.tmpIdx++}`;
            lines.push(
                `  ${fieldReg} = call %Field* @field_new(` +
                `i8* ${nameGep}, i8* ${typeNameGep}, ` +
                `i32 ${isProperty}, i32 ${isExportable}, i32 ${isFunction}, ` +
                `i32 ${isDisposable}, i32 ${isConst}, i8* ${returnTypeGep}, ` +
                `i32 ${isInitialized}, i8* ${initialValueGep})`
            );
            lines.push(`  ${castReg} = bitcast %Field* ${fieldReg} to i8*`);
            lines.push(`  call void @ptrarray_push(%PtrArray* ${fieldArrayReg}, i8* ${castReg})`);
        };

        // ── Emit: one entry per declared struct field ────────────────────────
        if (structFields) {
            for (const f of structFields) {
                const readableType = llvmTypeToReadableName(f.llvmType);
                // Build initialValue string from arrayInitValues: "[v0, v1, ...]" or ""
                const initVals     = f.arrayInitValues;
                const isInit: 0|1  = initVals && initVals.length > 0 ? 1 : 0;
                const initStr      = isInit ? `[${initVals!.join(', ')}]` : '';
                emitFieldEntry(
                    f.name,
                    readableType,
                    /* isProperty    */ 0,
                    /* isExportable  */ 0,
                    /* isFunction    */ 0,
                    /* isDisposable  */ f.isDisposable  ? 1 : 0,
                    // isConst = field modifier const (readonly) OR const-qualified type
                    /* isConst       */ (f.readonly || f.constType) ? 1 : 0,
                    /* returnType    */ readableType,
                    /* isInitialized */ isInit,
                    /* initialValue  */ initStr,
                );
            }
        }

        // ── Emit: one entry per declared struct method ───────────────────────
        if (structMethods) {
            for (const m of structMethods) {
                emitFieldEntry(
                    m.name,
                    m.returnType,
                    /* isProperty    */ 0,
                    /* isExportable  */ m.isExportable ? 1 : 0,
                    /* isFunction    */ 1,
                    /* isDisposable  */ 0,
                    /* isConst       */ m.isConst      ? 1 : 0,
                    /* returnType    */ m.returnType,
                    /* isInitialized */ 0,
                    /* initialValue  */ '',
                );
            }
        }

        // ── Emit: typeinfo_new(name, fields) ────────────────────────────────
        // fields is now %PtrArray* (Array<Field>), not %FieldArray*.
        this.rawInternString(typeName);
        const nameStr = this.rawStringGep(typeName);
        const result  = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = call %TypeInfo* @typeinfo_new(i8* ${nameStr}, %PtrArray* ${fieldArrayReg})`);
        return result;
    }

    /**
     * cast<T>(value: Any): T
     *
     * Emits a bitcast from `%Any*` to the target LLVM type T.
     * The target type must be supplied explicitly (`cast<string>(x)`) or
     * be inferrable from the assignment context (`const s: string = cast(x)`).
     *
     * Safety: the caller is responsible for ensuring `value` was originally
     * of type T.  Using the wrong T is undefined behaviour.
     */
    private emitCastIntrinsic(
        lines:  string[],
        args:   Expression[],
        varCtx: VarCtx,
        env:    Map<string, string>,
    ): string {
        const T         = env.get('T') ?? 'i8*';
        const targetTy  = toLLVM(T);
        const anyVal    = args.length > 0 ? this.emitExpr(lines, args[0], varCtx, '%Any*') : 'undef';
        const result    = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = bitcast %Any* ${anyVal} to ${targetTy}`);
        return result;
    }

    // ── addressOf ─────────────────────────────────────────────────────────────
    //
    //   addressOf<T>(value: T): Int64
    //
    // Returns the memory address of `value` as an i64.
    //
    //   • Pointer types (%T*, i8* …): the pointer *value* is ptrtoint'd to i64.
    //     This gives the address of the heap object (struct, array, …).
    //
    //   • Scalar types (i1, i32, i64, double …): a temporary stack slot is
    //     allocated, the value stored, and the slot's address is returned.
    //     The address is valid only within the current stack frame.
    //
    // Equivalent to &x in C / Zig, addr_of! in Rust.

    private emitAddressOfIntrinsic(
        lines:  string[],
        args:   Expression[],
        varCtx: VarCtx,
        env:    Map<string, string>,
    ): string {
        if (args.length === 0) { return '0'; }

        const valTy = toLLVM(env.get('T') ?? this.inferType(args[0], varCtx));

        // Pointer / opaque struct type: emit value first, then ptrtoint.
        // Emitting first keeps register numbers in sequential order.
        if (valTy.includes('*')) {
            const val    = this.emitExpr(lines, args[0], varCtx, valTy, false);
            const result = `%${this.tmpIdx++}`;
            lines.push(`  ${result} = ptrtoint ${valTy} ${val} to i64`);
            return result;
        }

        // Scalar: emit value first, then alloca+store+ptrtoint.
        // Registers are allocated after emitExpr so numbering stays sequential.
        const val    = this.emitExpr(lines, args[0], varCtx, valTy, false);
        const al     = alignOf(valTy);
        const slot   = `%${this.tmpIdx++}`;
        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${slot} = alloca ${valTy}, align ${al}`);
        lines.push(`  store ${valTy} ${val}, ${valTy}* ${slot}, align ${al}`);
        lines.push(`  ${result} = ptrtoint ${valTy}* ${slot} to i64`);
        return result;
    }

    // ── typeAddress ───────────────────────────────────────────────────────────
    //
    //   typeAddress<T>(value: T): Int64
    //
    // Convenience wrapper: calls typeInfo(value) then addressOf(info).
    // Returns the runtime address of the TypeInfo descriptor for T.

    private emitTypeAddressIntrinsic(
        lines:        string[],
        args:         Expression[],
        varCtx:       VarCtx,
        env:          Map<string, string>,
        callTypeArgs?: TypeReference[],
    ): string {
        // Emit typeInfo(value) → %TypeInfo*
        const infoReg = this.emitTypeInfoIntrinsic(lines, args, varCtx, env, callTypeArgs);

        // ptrtoint %TypeInfo* to i64
        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = ptrtoint %TypeInfo* ${infoReg} to i64`);
        return result;
    }

    private emitCallInstrExt(
        lines:   string[],
        ext:     ExternDeclaration,
        args:    Expression[],
        varCtx:  VarCtx,
        capture: boolean,
    ): string {
        const retTy     = resolveTypeRef(ext.returnType);
        const irRetTy   = toLLVM(retTy);
        const retIsWide = isWideSimdTy(irRetTy);
        const hasWidePm = ext.parameters.some(p => isWideSimdTy(toLLVM(resolveParamType(p))));

        // Wide SIMD types (>128-bit) cannot be passed by value across the LLVM IR→C
        // boundary on ARM64.  Route to the pointer-based wrapper.
        if (retIsWide || hasWidePm) {
            return this.emitCallInstrExtWideSIMD(lines, ext, args, varCtx, capture);
        }

        const argStr = ext.parameters
            .map((p, i) => {
                const ty     = resolveParamType(p);
                // Use raw (no-\n) string constants for function call arguments
                const rawStr = ty === 'i8*';
                const val    = i < args.length
                    ? this.emitExpr(lines, args[i], varCtx, ty, rawStr)
                    : 'undef';
                return `${toLLVM(ty)} ${val}`;
            })
            .join(', ');

        if (!retTy || retTy === 'void') {
            lines.push(`  call void @${ext.name}(${argStr})`);
            return '';
        }
        const tmp = `%${this.tmpIdx++}`;
        lines.push(`  ${tmp} = call ${irRetTy} @${ext.name}(${argStr})`);
        if (!capture) lines.push(`  ; result of @${ext.name} discarded`);
        return tmp;
    }

    /**
     * Emit a call to an extern C function whose signature involves wide SIMD
     * types (>128-bit vectors like <8 x float> or <16 x float>).
     *
     * Strategy — matches the pointer-based C API in runtime/simd.c:
     *   • Wide return value  → declare as void; first C arg is float* or double*
     *     (out-buffer).  IR: alloca the vector, bitcast to elemTy*, call void,
     *     then load the result.
     *   • Wide parameter     → C arg is float* or double*.
     *     IR: alloca the vector, store the value, bitcast to elemTy*, pass ptr.
     *   • Scalar params/ret  → unchanged (passed by value as before).
     */
    private emitCallInstrExtWideSIMD(
        lines:   string[],
        ext:     ExternDeclaration,
        args:    Expression[],
        varCtx:  VarCtx,
        capture: boolean,
    ): string {
        const retTy     = resolveTypeRef(ext.returnType);
        const irRetTy   = toLLVM(retTy);
        const retIsWide = isWideSimdTy(irRetTy);

        const callArgs: string[] = [];

        // ── Return-value out-pointer (first C arg when return is wide SIMD) ───
        let retAlloca: string | null = null;
        if (retIsWide) {
            const retElemTy = irRetTy.includes('double') ? 'double' : 'float';
            retAlloca  = `%${this.tmpIdx++}`;
            lines.push(`  ${retAlloca} = alloca ${irRetTy}, align ${alignOf(irRetTy)}`);
            const castPtr = `%${this.tmpIdx++}`;
            lines.push(`  ${castPtr} = bitcast ${irRetTy}* ${retAlloca} to ${retElemTy}*`);
            callArgs.push(`${retElemTy}* ${castPtr}`);
        }

        // ── Parameters ───────────────────────────────────────────────────────
        for (let i = 0; i < ext.parameters.length; i++) {
            const p   = ext.parameters[i];
            const ty  = resolveParamType(p);
            const irTy = toLLVM(ty);

            if (isWideSimdTy(irTy)) {
                const pElemTy = irTy.includes('double') ? 'double' : 'float';
                const val = i < args.length
                    ? this.emitExpr(lines, args[i], varCtx, ty, false)
                    : 'undef';
                // Alloca, store, bitcast to float*, pass pointer
                const allocaPtr = `%${this.tmpIdx++}`;
                lines.push(`  ${allocaPtr} = alloca ${irTy}, align ${alignOf(irTy)}`);
                lines.push(`  store ${irTy} ${val}, ${irTy}* ${allocaPtr}, align ${alignOf(irTy)}`);
                const castPtr = `%${this.tmpIdx++}`;
                lines.push(`  ${castPtr} = bitcast ${irTy}* ${allocaPtr} to ${pElemTy}*`);
                callArgs.push(`${pElemTy}* ${castPtr}`);
            } else {
                const rawStr = irTy === 'i8*';
                const val = i < args.length
                    ? this.emitExpr(lines, args[i], varCtx, ty, rawStr)
                    : 'undef';
                callArgs.push(`${irTy} ${val}`);
            }
        }

        const argStr = callArgs.join(', ');

        if (retIsWide) {
            // C function is void; result lands in the out-buffer
            lines.push(`  call void @${ext.name}(${argStr})`);
            const result = `%${this.tmpIdx++}`;
            lines.push(`  ${result} = load ${irRetTy}, ${irRetTy}* ${retAlloca!}, align ${alignOf(irRetTy)}`);
            return capture ? result : '';
        } else if (!retTy || retTy === 'void') {
            lines.push(`  call void @${ext.name}(${argStr})`);
            return '';
        } else {
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call ${irRetTy} @${ext.name}(${argStr})`);
            if (!capture) lines.push(`  ; result of @${ext.name} discarded`);
            return tmp;
        }
    }

    // ── Expression emission ───────────────────────────────────────────────────

    private emitExpr(
        lines:      string[],
        expr:       Expression,
        varCtx:     VarCtx,
        expectedTy: string,
        rawString:  boolean = false,
    ): string {
        if (isStringLiteral(expr)) {
            const inner = (expr as StringLiteral).value;
            // Use the raw (no trailing \n) constant whenever:
            //   • the caller explicitly requested it (rawString = true), OR
            //   • the expected context is an i8* value (variable, argument, return value).
            // The newline-suffixed constant is reserved for `printf` format-string
            // calls where no explicit format string is supplied — that code path was
            // removed in favour of always using `%s\n` as the format.
            if (rawString || expectedTy === 'i8*') {
                const sc = this.rawStrMap.get(inner);
                if (sc) return `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
            }
            const sc = this.strMap.get(inner)!;
            return `getelementptr inbounds ([${sc.byteLen} x i8], [${sc.byteLen} x i8]* @${sc.globalName}, i32 0, i32 0)`;
        }

        if (isTemplateLiteral(expr)) {
            return this.emitTemplateLiteral(lines, expr as TemplateLiteral, varCtx);
        }

        if (isNumberLiteral(expr)) {
            const raw = (expr as NumberLiteral).value;
            if (isNumberTy(expectedTy)) {
                // Box the literal into a heap-allocated Number*
                const tmp = `%${this.tmpIdx++}`;
                if (String(raw).includes('.')) {
                    lines.push(`  ${tmp} = call %Number* @number_from_double(double ${raw})`);
                } else {
                    lines.push(`  ${tmp} = call %Number* @number_from_int64(i64 ${Math.trunc(raw)})`);
                }
                return tmp;
            }
            if (isFloatTy(expectedTy) || expectedTy.startsWith('<'))
                return floatLitForType(raw, expectedTy);
            return String(Math.trunc(raw));
        }

        if (isBoolLiteral(expr)) return (expr as BoolLiteral).value ? '1' : '0';

        if (isVariableRef(expr)) {
            const name = (expr as VariableRef).ref.$refText;
            const info = varCtx.get(name);
            if (!info) {
                // Could be a named function reference used as a first-class value
                const localEntry = this.localFnScope.get(name);
                const fn = this.fnTable.get(name) ?? localEntry?.fn;
                if (fn) {
                    // Use the mangled IR name for nested functions (e.g. "main.double")
                    const irName = localEntry ? localEntry.mangledName : fn.name;
                    return this.emitFnRefValue(lines, fn, irName);
                }
                return 'undef';
            }
            const tmp = `%${this.tmpIdx++}`, ty = info.llvmType;
            const irTy = toLLVM(ty);
            lines.push(`  ${tmp} = load ${irTy}, ${ptrOf(ty)} ${info.allocaName}, align ${alignOf(ty)}`);
            // Auto-cast: widen / narrow to match the expected numeric type.
            if (expectedTy !== ty && this.canCast(ty, expectedTy))
                return this.emitCast(lines, tmp, ty, expectedTy);
            return tmp;
        }

        if (isSelfExpression(expr)) {
            const selfInfo = varCtx.get('self');
            if (!selfInfo) return 'undef';
            const tmp = `%${this.tmpIdx++}`;
            const selfIRTy = toLLVM(selfInfo.llvmType);
            lines.push(`  ${tmp} = load ${selfIRTy}, ${ptrOf(selfInfo.llvmType)} ${selfInfo.allocaName}, align ${alignOf(selfInfo.llvmType)}`);
            return tmp;
        }

        if (isFieldAccess(expr)) {
            return this.emitFieldAccess(lines, expr as FieldAccess, varCtx);
        }

        if (isChainedMemberCallExpr(expr)) {
            return this.emitChainedMemberCall(lines, expr as ChainedMemberCallExpr, varCtx, true);
        }

        if (isPostfixCallExpr(expr)) {
            return this.emitPostfixCallExpr(lines, expr as PostfixCallExpr, varCtx, true);
        }

        if (isMemberCallExpression(expr)) {
            const mce = expr as MemberCallExpression;
            let mceReceiver = (mce as any).selfCall ? 'self' : (mce.namespace ?? 'undef');

            // ── Generic collection alias resolution ───────────────────────────
            //
            // Two supported syntaxes:
            //
            //   1. Explicit type args on the receiver:
            //        let ii = Map<int, int>.new()
            //        let s  = Set<string>.new()
            //      → nsTypeArgs present → resolve to concrete LLVM type → use concrete name
            //
            //   2. No type args but variable has a type annotation:
            //        let ii: Map<int, int> = Map.new()
            //      → expectedTy is the concrete collection type → derive concrete name from it
            //
            if (!varCtx.has(mceReceiver) && GENERIC_COLLECTION_ALIASES.has(mceReceiver)) {
                const nsTypeArgs = (mce as any).nsTypeArgs as TypeReference[] | undefined;
                if (nsTypeArgs?.length) {
                    // Case 1: Map<K,V>.method()
                    const concreteTy = resolveGenericAlias(mceReceiver, nsTypeArgs);
                    if (concreteTy) mceReceiver = llvmPtrTypeToName(concreteTy);
                } else if (expectedTy && expectedTy.startsWith('%') && expectedTy.endsWith('*')) {
                    // Case 2: Map.method() with type annotation on LHS
                    const concreteName = llvmPtrTypeToName(expectedTy);
                    if (this.staticTable.get(concreteName)?.has(mce.member)) {
                        mceReceiver = concreteName;
                    }
                }
            }

            const mceResult = this.emitMemberCallInstr(lines, mceReceiver, mce.member, mce.args, varCtx, true);
            // Coerce i8* (PtrArray.get result) → named struct pointer when the calling
            // context expects a specific struct type (e.g. `const u: User = arr.get(0)`).
            if (mceResult !== 'void' && mceResult !== 'undef'
                && expectedTy && isStructPtrTy(expectedTy)) {
                const inferred = this.typeMethodReturnType(
                    varCtx.get((mce as any).selfCall ? 'self' : (mce.namespace ?? ''))?.llvmType ?? '',
                    mce.member,
                );
                if (inferred === 'i8*') {
                    const castRes = `%${this.tmpIdx++}`;
                    lines.push(`  ${castRes} = bitcast i8* ${mceResult} to ${expectedTy}`);
                    return castRes;
                }
            }
            return mceResult;
        }

        if (isLambdaExpression(expr)) {
            return this.emitLambdaExpr(lines, expr as LambdaExpression, varCtx, expectedTy);
        }

        // self(arg1, arg2) — indirect call through `self` as a fat-pointer function value
        if (isSelfCallExpression(expr)) {
            const sce      = expr as SelfCallExpression;
            const selfInfo = varCtx.get('self');
            if (selfInfo && isFnValTy(selfInfo.llvmType)) {
                return this.emitIndirectCallInstr(lines, 'self', sce.args, varCtx, selfInfo, true, expectedTy);
            }
            // self is not a fn-value — emit a void no-op and warn
            return expectedTy !== 'void' ? '0' : '';
        }

        if (isCallExpression(expr)) {
            const ce = expr as CallExpression;
            const ceTypeArgs: TypeReference[] = (ce as any).typeArgs ?? [];
            return this.emitCallInstr(lines, ce.callee, ce.args, varCtx, true, false, expectedTy, ceTypeArgs.length > 0 ? ceTypeArgs : undefined);
        }

        if (isStructLiteral(expr)) {
            return this.emitStructLiteral(lines, expr as StructLiteral, varCtx);
        }

        if (isAnonymousStructLiteral(expr)) {
            // Infer struct type name from expectedTy (e.g. "%Point*" → "Point")
            const structName = expectedTy.replace(/^%/, '').replace(/\*$/, '');
            if (!this.structFieldMap.has(structName)) {
                throw new Error(
                    `Anonymous struct literal '{}': cannot infer struct type — ` +
                    `expected type '${expectedTy}' is not a known struct. ` +
                    `Add an explicit type annotation (e.g. 'let p: Point = {};').`
                );
            }
            const synthetic: StructLiteral = {
                $type: 'StructLiteral',
                $container: (expr as any).$container,
                $containerProperty: (expr as any).$containerProperty,
                typeName: structName,
                fields: (expr as AnonymousStructLiteral).fields,
            } as unknown as StructLiteral;
            return this.emitStructLiteral(lines, synthetic, varCtx);
        }

        if (isSuperCallExpression(expr)) {
            return this.emitSuperCallExpr(lines, expr as SuperCallExpression, varCtx, expectedTy);
        }

        if (isArrayLiteral(expr)) {
            return this.emitArrayLiteral(lines, expr as ArrayLiteral, varCtx, expectedTy);
        }

        if (isIfExpression(expr)) {
            // Prefer expectedTy; fall back to inferred type from the then-arm.
            const ty = (expectedTy !== 'void' && expectedTy !== 'undef')
                ? expectedTy
                : this.inferType(expr, varCtx);
            return this.emitIfExpr(lines, expr as IfExpression, varCtx, ty);
        }

        if (isSwitchExpression(expr)) {
            const ty = (expectedTy && expectedTy !== 'void' && expectedTy !== 'undef')
                ? expectedTy
                : this.inferType(expr, varCtx);
            return this.emitSwitchExpr(lines, expr as SwitchExpression, varCtx, ty);
        }

        if (isBinaryExpr(expr)) {
            return this.emitBinaryExpr(lines, expr as BinaryExpr, varCtx, expectedTy);
        }

        if (isUnaryExpr(expr)) {
            return this.emitUnaryExpr(lines, expr as UnaryExpr, varCtx, expectedTy);
        }

        // ── Enum constructor: Direction::North, Shape::Circle(5.0) ────────────
        if (isEnumConstructor(expr)) {
            const ec = expr as EnumConstructor;
            // Determine concrete LLVM enum type.
            // Prefer expectedTy (set from type annotation) for generic enum resolution.
            let enumTy: string;
            if (expectedTy && expectedTy !== 'i8*' && expectedTy !== 'void' && expectedTy !== 'undef'
                    && expectedTy.startsWith('%') && expectedTy.endsWith('*')) {
                enumTy = expectedTy;
            } else {
                enumTy = `%${ec.enumName}*`;
            }
            return this.emitEnumConstructorExpr(lines, ec, varCtx, enumTy);
        }

        // ── Macro call expression ─────────────────────────────────────────────
        if (isMacroCallExpression(expr)) {
            return this.emitMacroCallExpression(lines, expr as MacroCallExpression, varCtx, expectedTy);
        }

        return 'undef';
    }

    // ── Unary expression ──────────────────────────────────────────────────────
    //
    //   -x   (negate)
    //     integer:  sub <ty> 0, %x
    //     float:    fneg double %x
    //
    //   !x   (logical NOT)
    //     bool:     xor i1 %x, true

    private emitUnaryExpr(
        lines:      string[],
        expr:       UnaryExpr,
        varCtx:     VarCtx,
        expectedTy: string,
    ): string {
        const ty   = (expectedTy && expectedTy !== 'void' && expectedTy !== 'undef')
            ? expectedTy
            : this.inferType(expr.operand, varCtx);
        const irTy = toLLVM(ty);

        if (expr.op === '-') {
            // Number* negation: avoid emitting `sub %Number* 0, …`
            if (isNumberTy(irTy)) {
                if (isNumberLiteral(expr.operand)) {
                    // Fast path: literal operand → box the negated value directly
                    const raw = (expr.operand as NumberLiteral).value;
                    const res = `%${this.tmpIdx++}`;
                    if (String(raw).includes('.')) {
                        lines.push(`  ${res} = call %Number* @number_from_double(double -${raw})`);
                    } else {
                        lines.push(`  ${res} = call %Number* @number_from_int64(i64 -${Math.trunc(raw)})`);
                    }
                    return res;
                }
                // General case: number_sub(zero, operand)
                const operand = this.emitExpr(lines, expr.operand, varCtx, ty);
                const zeroReg = `%${this.tmpIdx++}`;
                const resReg  = `%${this.tmpIdx++}`;
                lines.push(`  ${zeroReg} = call %Number* @number_from_int64(i64 0)`);
                lines.push(`  ${resReg} = call %Number* @number_sub(%Number* ${zeroReg}, %Number* ${operand})`);
                return resReg;
            }
            const operand = this.emitExpr(lines, expr.operand, varCtx, ty);
            const res     = `%${this.tmpIdx++}`;
            if (irTy === 'double' || irTy === 'float') {
                lines.push(`  ${res} = fneg ${irTy} ${operand}`);
            } else {
                // Integer negation: sub 0, x  (works for all integer widths)
                lines.push(`  ${res} = sub ${irTy} 0, ${operand}`);
            }
            return res;
        }

        const operand = this.emitExpr(lines, expr.operand, varCtx, ty);
        const res     = `%${this.tmpIdx++}`;

        if (expr.op === '!') {
            // Logical NOT for booleans: xor with 1
            lines.push(`  ${res} = xor i1 ${operand}, true`);
            return res;
        }

        return 'undef';
    }

    // ── Binary expression ─────────────────────────────────────────────────────
    //
    //   a + b   →  add i32 %a, %b
    // ── Switch expression ─────────────────────────────────────────────────────
    //
    // Compiles:
    //   switch subject {
    //     "foo" => exprA,      ← expression arm: store result, br merge
    //     42    => exprB,      ← integer / float / bool pattern
    //     else  => exprC,      ← catch-all (no comparison)
    //   }
    //
    // Arms are checked top-to-bottom via a conditional-branch chain.
    // Expression arms store into a result alloca; block arms may `ret` early
    // or fall through to merge (so the alloca may remain uninitialised in that
    // path — callers must guarantee exhaustiveness if they use the value).
    //
    // String patterns use libc strcmp (declare i32 @strcmp(i8*, i8*) if not
    // already present).  All other patterns use native LLVM icmp eq.

    private emitSwitchExpr(
        lines:      string[],
        expr:       SwitchExpression,
        varCtx:     VarCtx,
        expectedTy: string,
    ): string {
        const idx = this.ifIdx++;

        // ── Result slot ──────────────────────────────────────────────────────
        const firstExprArm = expr.arms.find(a => a.expr);
        const inferredTy   = firstExprArm
            ? this.inferType(firstExprArm.expr!, varCtx)
            : (expectedTy || 'i8*');
        // Prefer expectedTy if it's more specific than the inferred fallback.
        // Enum pattern bindings (e.g. `x` in `Option::Some(x) => x`) are not yet
        // in varCtx during type inference, so inferType may return 'i8*' — in that
        // case a concrete expectedTy (from the function's declared return type) is
        // a better choice.
        const resultTy = (expectedTy && expectedTy !== 'i8*' && expectedTy !== 'undef' && expectedTy !== 'void')
            ? expectedTy
            : (inferredTy !== 'i8*' ? inferredTy : (expectedTy || 'i8*'));
        const llvmTy   = toLLVM(resultTy);
        const resultSlot = `%${this.tmpIdx++}`;
        lines.push(`  ${resultSlot} = alloca ${llvmTy}`);

        // ── Subject ─────────────────────────────────────────────────────────
        const subjectTy  = this.inferType(expr.subject, varCtx);
        const subjectVal = this.emitExpr(lines, expr.subject, varCtx, subjectTy);

        const mergeLabel = `switch.merge.${idx}`;

        // Separate pattern arms from the else arm
        const patternArms = expr.arms.filter(a => !a.else);
        const elseArm     = expr.arms.find(a => a.else);

        // Target when no pattern matches (else arm label or merge if absent)
        const noMatchTarget = elseArm
            ? `switch.arm.${idx}.${expr.arms.indexOf(elseArm)}`
            : mergeLabel;

        // ── Check chain ──────────────────────────────────────────────────────
        // Each pattern arm emits: compare → br arm_label, next_check_label
        for (let i = 0; i < patternArms.length; i++) {
            const arm         = patternArms[i];
            const armIdx      = expr.arms.indexOf(arm);
            const armLabel    = `switch.arm.${idx}.${armIdx}`;
            const nextTarget  = i + 1 < patternArms.length
                ? `switch.check.${idx}.${i + 1}`
                : noMatchTarget;

            const cmpReg = this.emitSwitchPattern(
                lines, arm, subjectVal, subjectTy, idx, i,
            );
            lines.push(`  br i1 ${cmpReg}, label %${armLabel}, label %${nextTarget}`);

            if (i + 1 < patternArms.length) {
                lines.push('');
                lines.push(`switch.check.${idx}.${i + 1}:`);
                this.currentLabel = `switch.check.${idx}.${i + 1}`;
            }
        }

        // If there are no pattern arms at all (only else), branch directly to it
        if (patternArms.length === 0 && elseArm) {
            const elseIdx = expr.arms.indexOf(elseArm);
            lines.push(`  br label %switch.arm.${idx}.${elseIdx}`);
        }

        // ── Arm bodies ───────────────────────────────────────────────────────
        for (let i = 0; i < expr.arms.length; i++) {
            const arm = expr.arms[i];
            lines.push('');
            lines.push(`switch.arm.${idx}.${i}:`);
            this.currentLabel = `switch.arm.${idx}.${i}`;

            // ── Enum pattern payload bindings ─────────────────────────────────
            // When this arm has an EnumPattern with bindings, destructure the
            // payload fields of the matched variant into named local variables
            // before executing the arm body.  We create an arm-local VarCtx
            // so that binding names are scoped to this arm only.
            const armVarCtx = arm.enumPat
                ? this.emitEnumPatternBindings(lines, arm.enumPat, subjectVal, varCtx, subjectTy)
                : varCtx;

            if (arm.block) {
                // Block arm — compile statements; return exits the function.
                const terminated = this.emitStatements(
                    lines, arm.block.statements, armVarCtx,
                );
                if (!terminated) {
                    // Block didn't return — fall through to merge (result undefined).
                    lines.push(`  br label %${mergeLabel}`);
                }
            } else if (arm.expr) {
                // Expression arm — store result, branch to merge.
                const armVal = this.emitExpr(lines, arm.expr, armVarCtx, resultTy);
                lines.push(`  store ${llvmTy} ${armVal}, ${llvmTy}* ${resultSlot}`);
                lines.push(`  br label %${mergeLabel}`);
            } else {
                // Degenerate arm (should not happen) — just branch to merge.
                lines.push(`  br label %${mergeLabel}`);
            }
        }

        // ── Merge block ──────────────────────────────────────────────────────
        lines.push('');
        lines.push(`${mergeLabel}:`);
        this.currentLabel = mergeLabel;

        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = load ${llvmTy}, ${llvmTy}* ${resultSlot}`);
        return result;
    }

    /**
     * Lower a SwitchStatement to a chain of conditional branches.
     *
     * Unlike SwitchExpression, no result value is produced — each arm body is
     * executed purely for side effects, then branches to the merge block.
     *
     * The structure emitted is:
     *
     *   ; check 0
     *   %cmp0 = …  ; compare subject against arm[0]'s pattern
     *   br i1 %cmp0, label %sw.arm.N.0, label %sw.check.N.1
     *
     *   sw.check.N.1:
     *   %cmp1 = …
     *   br i1 %cmp1, label %sw.arm.N.1, label %sw.else.N   ; or %sw.merge.N
     *
     *   sw.arm.N.0:
     *   … arm body statements …
     *   br label %sw.merge.N
     *
     *   sw.else.N:   ; (only if an else arm exists)
     *   … else body …
     *   br label %sw.merge.N
     *
     *   sw.merge.N:
     *
     * Returns true when ALL arms are guaranteed to terminate (every arm ends in
     * a return/panic/etc. and there is an else arm), otherwise false.
     */
    private emitSwitchStatement(
        lines:  string[],
        stmt:   SwitchStatement,
        varCtx: VarCtx,
    ): boolean {
        const idx = this.ifIdx++;

        // Evaluate subject once
        const subjectTy  = this.inferType(stmt.subject, varCtx);
        const subjectVal = this.emitExpr(lines, stmt.subject, varCtx, subjectTy);

        const mergeLabel = `sw.merge.${idx}`;

        const patternArms = stmt.arms.filter(a => !a.else);
        const elseArm     = stmt.arms.find(a => a.else);
        const noMatchTarget = elseArm
            ? `sw.arm.${idx}.${stmt.arms.indexOf(elseArm)}`
            : mergeLabel;

        // ── Emit pattern checks (chain of compare + conditional branch) ────────
        for (let i = 0; i < patternArms.length; i++) {
            const arm       = patternArms[i];
            const armIdx    = stmt.arms.indexOf(arm);
            const armLabel  = `sw.arm.${idx}.${armIdx}`;
            const nextTarget = i + 1 < patternArms.length
                ? `sw.check.${idx}.${i + 1}`
                : noMatchTarget;

            const cmpReg = this.emitSwitchPattern(lines, arm, subjectVal, subjectTy, idx, i);
            lines.push(`  br i1 ${cmpReg}, label %${armLabel}, label %${nextTarget}`);

            if (i + 1 < patternArms.length) {
                lines.push('');
                lines.push(`sw.check.${idx}.${i + 1}:`);
                this.currentLabel = `sw.check.${idx}.${i + 1}`;
            }
        }

        // If there are no pattern arms (only else), branch directly to it
        if (patternArms.length === 0 && elseArm) {
            const elseIdx = stmt.arms.indexOf(elseArm);
            lines.push(`  br label %sw.arm.${idx}.${elseIdx}`);
        }

        // ── Emit arm bodies ───────────────────────────────────────────────────
        let allTerminated = elseArm !== undefined; // assume true unless an arm doesn't terminate

        for (let i = 0; i < stmt.arms.length; i++) {
            const arm = stmt.arms[i];
            lines.push('');
            lines.push(`sw.arm.${idx}.${i}:`);
            this.currentLabel = `sw.arm.${idx}.${i}`;

            // Enum pattern payload bindings (reuse same mechanism as SwitchExpression)
            const armVarCtx = arm.enumPat
                ? this.emitEnumPatternBindings(lines, arm.enumPat, subjectVal, varCtx, subjectTy)
                : varCtx;

            const terminated = this.emitStatements(lines, arm.block.statements, armVarCtx);
            if (terminated) {
                // arm has a hard terminator — no explicit branch to merge needed
            } else {
                allTerminated = false;
                lines.push(`  br label %${mergeLabel}`);
            }
        }

        // ── Merge block ───────────────────────────────────────────────────────
        // Only emit the merge block when at least one arm branches to it.
        // If every arm terminates (all return/panic/unreachable), the merge block
        // is unreachable — omitting it keeps the IR valid.
        if (!allTerminated || !elseArm) {
            lines.push('');
            lines.push(`${mergeLabel}:`);
            this.currentLabel = mergeLabel;
        }

        // We return true only when we can guarantee no fall-through:
        // every arm terminates AND an else arm covers all un-matched cases.
        return allTerminated && elseArm !== undefined;
    }

    /**
     * Emit an i1 comparison between the already-loaded subject value and the
     * literal pattern stored in `arm`.  Returns the register holding the i1.
     *
     * Dispatches:
     *   enumPat → load tag from %EnumName*, icmp eq i32 tag, expected_tag
     *   strPat  → declare + call i32 @strcmp(i8*, i8*), icmp eq i32 result, 0
     *   numPat  → icmp eq i32/double  (int/float subject)
     *   truePat → icmp eq i1 subject, 1
     *   falsePat → icmp eq i1 subject, 0
     */
    private emitSwitchPattern(
        lines:      string[],
        arm:        SwitchArm | SwitchStmtArm,
        subjectVal: string,
        subjectTy:  string,
        _switchIdx: number,
        _armSeqIdx: number,
    ): string {
        // ── Enum pattern: Direction::North, Shape::Circle(r), Option::None ────
        if (arm.enumPat) {
            const pat      = arm.enumPat;
            const baseName = subjectTy.replace(/^%/, '').replace(/\*$/, '');
            const declName = baseName.includes('_') ? baseName.split('_')[0] : baseName;
            const decl     = this.enumDeclMap.get(declName) ?? this.enumDeclMap.get(baseName);
            const tagMap   = decl ? (this.enumVariantTags.get(decl.name) ?? new Map()) : new Map();
            const tag      = tagMap.get(pat.variant) ?? 0;

            // Load the tag field (index 0) from the enum pointer
            const baseTy  = `%${baseName}`;
            const ptrTy   = `%${baseName}*`;
            const tagPtrReg = `%${this.tmpIdx++}`;
            const tagValReg = `%${this.tmpIdx++}`;
            const cmpReg    = `%${this.tmpIdx++}`;
            lines.push(`  ${tagPtrReg} = getelementptr inbounds ${baseTy}, ${ptrTy} ${subjectVal}, i32 0, i32 0`);
            lines.push(`  ${tagValReg} = load i32, i32* ${tagPtrReg}, align 4`);
            lines.push(`  ${cmpReg} = icmp eq i32 ${tagValReg}, ${tag}`);
            return cmpReg;
        }

        if (arm.strPat !== undefined) {
            // String pattern — compare via libc strcmp.
            // Allocate registers in emission order to satisfy LLVM's sequential numbering.
            this.needsStrcmpDecl = true;
            const patGep  = this.rawStringGep(arm.strPat);
            const i32Reg  = `%${this.tmpIdx++}`;
            const cmpReg  = `%${this.tmpIdx++}`;
            lines.push(`  ${i32Reg} = call i32 @strcmp(i8* ${subjectVal}, i8* ${patGep})`);
            lines.push(`  ${cmpReg} = icmp eq i32 ${i32Reg}, 0`);
            return cmpReg;
        }

        const cmpReg = `%${this.tmpIdx++}`;

        if (arm.numPat !== undefined) {
            // Numeric pattern
            const isFloat = isFloatTy(subjectTy);
            if (isFloat) {
                lines.push(`  ${cmpReg} = fcmp oeq ${toLLVM(subjectTy)} ${subjectVal}, ${arm.numPat}`);
            } else {
                lines.push(`  ${cmpReg} = icmp eq ${toLLVM(subjectTy)} ${subjectVal}, ${arm.numPat}`);
            }
        } else if (arm.truePat) {
            // Bool true pattern
            lines.push(`  ${cmpReg} = icmp eq i1 ${subjectVal}, 1`);
        } else if (arm.falsePat) {
            // Bool false pattern
            lines.push(`  ${cmpReg} = icmp eq i1 ${subjectVal}, 0`);
        } else {
            // Fallback (should not happen for non-else arms)
            lines.push(`  ${cmpReg} = icmp eq i32 0, 0`);
        }

        return cmpReg;
    }

    //   a - b   →  sub i32 %a, %b
    //   a * b   →  mul i32 %a, %b
    //   a / b   →  sdiv i32 %a, %b   (signed division for integers)
    //   a % b   →  srem i32 %a, %b
    //   float variants use fadd / fsub / fmul / fdiv / frem

    private emitBinaryExpr(
        lines:      string[],
        expr:       BinaryExpr,
        varCtx:     VarCtx,
        expectedTy: string,
    ): string {
        // ── Comparison operators → icmp returning i1 ──────────────────────────
        // These operators arise when `==`, `!=`, `<`, etc. appear in expression
        // context (e.g. `return x % 2 == 0;`).  They always produce an i1 result,
        // regardless of expectedTy, so handle them before the normal type routing.
        const COMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);
        if (COMP_OPS.has(expr.op)) {
            return this.emitComparisonExpr(lines, expr, varCtx);
        }

        // Determine operand type: prefer a concrete expectedTy, otherwise infer.
        const ty = (expectedTy && expectedTy !== 'i8*' && expectedTy !== 'void' && expectedTy !== 'undef')
            ? expectedTy
            : this.inferType(expr.left, varCtx);

        // ── Dynamic Number arithmetic → C runtime calls ────────────────────────
        if (isNumberTy(ty)) {
            const lv     = this.emitExpr(lines, expr.left,  varCtx, NUMBER_TY);
            const rv     = this.emitExpr(lines, expr.right, varCtx, NUMBER_TY);
            const fnName = NUMBER_ARITH_FN[expr.op] ?? 'number_add';
            const result = `%${this.tmpIdx++}`;
            lines.push(`  ${result} = call %Number* @${fnName}(%Number* ${lv}, %Number* ${rv})`);
            return result;
        }

        // ── String concatenation: i8* + i8* → concat(a, b) ───────────────────────
        if (ty === 'i8*' && expr.op === '+') {
            this.needsConcatDecl = !this.externTable.has('concat');
            const lv     = this.emitExpr(lines, expr.left,  varCtx, 'i8*', /*rawString=*/true);
            const rv     = this.emitExpr(lines, expr.right, varCtx, 'i8*', /*rawString=*/true);
            const result = `%${this.tmpIdx++}`;
            lines.push(`  ${result} = call i8* @concat(i8* ${lv}, i8* ${rv})`);
            return result;
        }

        // ── Extension method dispatch (BinaryAdd / BinarySub / BitAnd / …) ───────
        //
        // When the left-operand type has an extension method whose name matches
        // the operator, dispatch the binary expression through that method.
        //
        //   a + b   →  TypeName_add(a, b)    (arithmetic protocols)
        //   a & b   →  TypeName_bitAnd(a, b) (bitwise protocols)
        //   a << b  →  TypeName_shl(a, b)    etc.
        //
        // Number uses the C-runtime path above; primitives fall through to LLVM
        // instructions below — extension method dispatch only fires for types
        // that actually have the matching method in the extension table.
        {
            const OP_TO_METHOD: Record<string, string> = {
                '+': 'add',    '-': 'sub',    '*': 'mul',    '/': 'div',    '%': 'mod',
                '&': 'bitAnd', '|': 'bitOr',  '^': 'bitXor', '<<': 'shl',   '>>': 'shr',
            };
            const methodName = OP_TO_METHOD[expr.op];
            if (methodName) {
                const extMethods = this.extTable.get(ty);
                if (extMethods?.has(methodName)) {
                    const entry      = extMethods.get(methodName)!;
                    const lv         = this.emitExpr(lines, expr.left,  varCtx, ty);
                    // Use the method's declared first-parameter type for the RHS so
                    // that operators whose right operand differs from the receiver type
                    // (e.g. Flags & int) emit the correct LLVM argument type.
                    const paramTy   = entry.method.parameters.length > 0
                        ? resolveTypeRef(entry.method.parameters[0].type)
                        : ty;
                    const rv         = this.emitExpr(lines, expr.right, varCtx, paramTy);
                    const mangledName = `${entry.typeName}_${methodName}`;
                    const retTy      = entry.method.returnType
                        ? resolveTypeRef(entry.method.returnType)
                        : ty;
                    const irTy2      = toLLVM(ty);
                    const irParamTy  = toLLVM(paramTy);
                    const result     = `%${this.tmpIdx++}`;
                    lines.push(`  ${result} = call ${toLLVM(retTy)} @${mangledName}(${irTy2} ${lv}, ${irParamTy} ${rv})`);
                    return result;
                }
            }
        }

        const leftVal  = this.emitExpr(lines, expr.left,  varCtx, ty);
        const rightVal = this.emitExpr(lines, expr.right, varCtx, ty);

        const irTy    = toLLVM(ty);
        const isFloat = isFloatTy(ty) || isSimdVectorTy(irTy);
        const isUint  = isUnsignedTy(ty);
        let instr: string;
        switch (expr.op) {
            case '+':  instr = isFloat ? `fadd ${irTy}` : `add ${irTy}`; break;
            case '-':  instr = isFloat ? `fsub ${irTy}` : `sub ${irTy}`; break;
            case '*':  instr = isFloat ? `fmul ${irTy}` : `mul ${irTy}`; break;
            case '/':  instr = isFloat ? `fdiv ${irTy}` : isUint ? `udiv ${irTy}` : `sdiv ${irTy}`; break;
            case '%':  instr = isFloat ? `frem ${irTy}` : isUint ? `urem ${irTy}` : `srem ${irTy}`; break;
            // ── Bitwise (integer only; no float semantics) ─────────────────────
            case '&':  instr = `and ${irTy}`; break;
            case '|':  instr = `or ${irTy}`;  break;
            case '^':  instr = `xor ${irTy}`; break;
            case '<<': instr = `shl ${irTy}`; break;
            // Arithmetic right-shift for signed types; logical for unsigned.
            case '>>': instr = isUint ? `lshr ${irTy}` : `ashr ${irTy}`; break;
            default:   instr = `add ${irTy}`; break;
        }

        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = ${instr} ${leftVal}, ${rightVal}`);
        return result;
    }

    /**
     * Emit a comparison binary expression (`==`, `!=`, `<`, `>`, `<=`, `>=`).
     * Returns an i1 value.  Called from `emitBinaryExpr` and transitively from
     * `emitBoolExprCondition` for comparison conditions.
     */
    private emitComparisonExpr(
        lines:  string[],
        expr:   BinaryExpr,
        varCtx: VarCtx,
    ): string {
        const leftTy = this.inferType(expr.left, varCtx);

        // Number comparisons via C-runtime
        if (isNumberTy(leftTy)) {
            const lv     = this.emitExpr(lines, expr.left,  varCtx, NUMBER_TY);
            const rv     = this.emitExpr(lines, expr.right, varCtx, NUMBER_TY);
            const fnName = NUMBER_CMP_FN[expr.op] ?? 'number_eq';
            const i32reg = `%${this.tmpIdx++}`;
            lines.push(`  ${i32reg} = call i32 @${fnName}(%Number* ${lv}, %Number* ${rv})`);
            const cmpReg = `%${this.tmpIdx++}`;
            lines.push(`  ${cmpReg} = trunc i32 ${i32reg} to i1`);
            return cmpReg;
        }

        // Bool (i1) — native icmp only (avoid Boolean_eq recursion)
        if (leftTy === 'i1' && (expr.op === '==' || expr.op === '!=')) {
            const lv = this.emitExpr(lines, expr.left,  varCtx, 'i1');
            const rv = this.emitExpr(lines, expr.right, varCtx, 'i1');
            const op = icmpOp(expr.op, 'i1');
            const r  = `%${this.tmpIdx++}`;
            lines.push(`  ${r} = ${op} i1 ${lv}, ${rv}`);
            return r;
        }

        // Equality via extension method
        if (expr.op === '==' || expr.op === '!=') {
            const extMethods = this.extTable.get(leftTy);
            if (extMethods?.has('eq')) {
                const entry       = extMethods.get('eq')!;
                const lv          = this.emitExpr(lines, expr.left,  varCtx, leftTy);
                const rv          = this.emitExpr(lines, expr.right, varCtx, leftTy);
                const mangledName = `${entry.typeName}_eq`;
                const irTy        = toLLVM(leftTy);
                const eqReg       = `%${this.tmpIdx++}`;
                lines.push(`  ${eqReg} = call i1 @${mangledName}(${irTy} ${lv}, ${irTy} ${rv})`);
                if (expr.op === '!=') {
                    const notReg = `%${this.tmpIdx++}`;
                    lines.push(`  ${notReg} = xor i1 ${eqReg}, true`);
                    return notReg;
                }
                return eqReg;
            }
        }

        // Ordering via extension method
        if (expr.op === '<' || expr.op === '>' || expr.op === '<=' || expr.op === '>=') {
            const extMethods = this.extTable.get(leftTy);
            const methodName  = extMethods?.has('cmp')
                ? 'cmp'
                : extMethods?.has('partialCmp')
                ? 'partialCmp'
                : null;
            if (methodName) {
                const entry       = extMethods!.get(methodName)!;
                const lv          = this.emitExpr(lines, expr.left,  varCtx, leftTy);
                const rv          = this.emitExpr(lines, expr.right, varCtx, leftTy);
                const mangledName = `${entry.typeName}_${methodName}`;
                const irTy        = toLLVM(leftTy);
                const cmpReg      = `%${this.tmpIdx++}`;
                lines.push(`  ${cmpReg} = call i32 @${mangledName}(${irTy} ${lv}, ${irTy} ${rv})`);
                const OP_TO_ICMP: Record<string, string> = {
                    '<':  'icmp slt', '>':  'icmp sgt',
                    '<=': 'icmp sle', '>=': 'icmp sge',
                };
                const boolReg = `%${this.tmpIdx++}`;
                lines.push(`  ${boolReg} = ${OP_TO_ICMP[expr.op]} i32 ${cmpReg}, 0`);
                return boolReg;
            }
        }

        // Pointer-to-null comparison: `ptr == 0` / `ptr != 0`
        // LLVM requires `null` for pointer comparisons, not integer `0`.
        const irLeftTy = toLLVM(leftTy);
        const isPtr    = irLeftTy.endsWith('*');
        if (isPtr && (expr.op === '==' || expr.op === '!=')) {
            const rightIsZero =
                (isNumberLiteral(expr.right) && (expr.right as NumberLiteral).value === 0) ||
                (isBinaryExpr(expr.right) === false && isVariableRef(expr.right) === false &&
                    String((expr.right as any).value ?? '') === '0');
            const lv  = this.emitExpr(lines, expr.left, varCtx, leftTy);
            const rv  = rightIsZero ? 'null' : this.emitExpr(lines, expr.right, varCtx, leftTy);
            const op  = icmpOp(expr.op, leftTy);
            const r   = `%${this.tmpIdx++}`;
            lines.push(`  ${r} = ${op} ${irLeftTy} ${lv}, ${rv}`);
            return r;
        }

        // Native LLVM icmp
        const lv  = this.emitExpr(lines, expr.left,  varCtx, leftTy);
        const rv  = this.emitExpr(lines, expr.right, varCtx, leftTy);
        const op  = icmpOp(expr.op, leftTy);
        const r   = `%${this.tmpIdx++}`;
        lines.push(`  ${r} = ${op} ${irLeftTy} ${lv}, ${rv}`);
        return r;
    }

    // ── Template literal emission ─────────────────────────────────────────────
    //
    // $"hello {name}!" is lowered to a series of concat() calls at runtime:
    //
    //   %t0 = (rawPtr for "hello ")
    //   %t1 = load i8*, i8** %name ...
    //   %t2 = call i8* @concat(i8* %t0, i8* %t1)
    //   %t3 = (rawPtr for "!")
    //   %t4 = call i8* @concat(i8* %t2, i8* %t3)
    //   → returns %t4
    //
    // Non-string holes are converted:
    //   integer  → int_to_string(n)
    //   double   → float_to_string(f)
    //   bool i1  → select i1, "true", "false"
    //   i8*      → used as-is

    private emitTemplateLiteral(lines: string[], expr: TemplateLiteral, varCtx: VarCtx): string {
        const parts = parseTemplateParts(expr.value);

        if (parts.length === 0) {
            // Empty template → empty raw string
            this.rawInternString('');
            return this.rawStringGep('');
        }

        // Convert each part to an i8* value
        const ptrs: string[] = [];

        for (const part of parts) {
            if (part.kind === 'literal') {
                ptrs.push(this.rawStringGep(part.text));
            } else {
                // Parse and emit the hole expression
                const mini     = parseMiniExpr(part.text);
                const { reg, ty } = this.emitMiniExpr(lines, mini, varCtx);
                const strPtr   = this.convertHoleToString(lines, reg, ty);
                ptrs.push(strPtr);
            }
        }

        // Fold all parts into one string via concat
        if (ptrs.length === 1) return ptrs[0];

        let acc = ptrs[0];
        for (let i = 1; i < ptrs.length; i++) {
            this.needsConcatDecl = !this.externTable.has('concat');
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = call i8* @concat(i8* ${acc}, i8* ${ptrs[i]})`);
            acc = tmp;
        }
        return acc;
    }

    /**
     * Emit IR for a mini-expression (parsed from a template hole).
     * Returns the result register and its LLVM type.
     */
    private emitMiniExpr(lines: string[], expr: MiniExpr, varCtx: VarCtx): { reg: string; ty: string } {
        if (expr.kind === 'num') {
            const isFloat = String(expr.value).includes('.');
            return isFloat
                ? { reg: String(expr.value), ty: 'double' }
                : { reg: String(Math.trunc(expr.value)), ty: 'i32' };
        }

        if (expr.kind === 'id') {
            const info = varCtx.get(expr.name);
            if (!info) return { reg: 'undef', ty: 'i8*' };
            const tmp   = `%${this.tmpIdx++}`;
            const ty    = info.llvmType;
            const irTy  = toLLVM(ty);
            lines.push(`  ${tmp} = load ${irTy}, ${ptrOf(ty)} ${info.allocaName}, align ${alignOf(ty)}`);
            return { reg: tmp, ty };
        }

        if (expr.kind === 'member') {
            // Walk a chain of struct field accesses like `self.data.length`,
            // or handle method calls on primitives like `item.toString()`.
            const rootInfo = varCtx.get(expr.obj);
            if (!rootInfo) {
                // expr.obj is not a local variable — try static type or namespace dispatch.
                // e.g. `OS.hostname` written without `()` in a template hole is treated as
                // a zero-arg static method call so it still produces a useful value.
                return this.emitMiniStaticCall(lines, expr.obj, expr.fields[0], [], varCtx);
            }

            // Start by loading the root value from its alloca
            let currentTy    = rootInfo.llvmType;   // e.g. "%IntStack*"
            let currentAlloca = rootInfo.allocaName; // e.g. "%self"
            let isAlloca     = true;                 // first step loads from alloca
            // Track which variable name is the current receiver (for method dispatch).
            let currentVarName: string | null = expr.obj;

            for (let fi = 0; fi < expr.fields.length; fi++) {
                const field  = expr.fields[fi];
                const baseTy = currentTy.replace(/\*$/, '');  // "%IntStack"
                const tn     = baseTy.replace(/^%/, '');       // "IntStack"
                const fields = this.structFieldMap.get(tn);

                if (!fields) {
                    // No struct field map — the current type is a primitive or opaque
                    // type.  Treat this as a zero-arg method call and dispatch through
                    // the full emitMemberCallInstr pipeline (handles built-in int/float/
                    // string/bool methods and extension methods).
                    //
                    // Two sub-cases:
                    //   a) fi === 0: receiver is the original named variable — use
                    //      expr.obj directly (it lives in varCtx).
                    //   b) fi > 0 : receiver is a loaded value that is NOT in varCtx;
                    //      we stash it in a temp alloca so emitMemberCallInstr can find it.
                    let receiverVarName: string;
                    if (currentVarName !== null) {
                        receiverVarName = currentVarName;
                    } else {
                        // Stash the intermediate loaded value into a fresh alloca so
                        // emitMemberCallInstr can load it back via varCtx.
                        const tmpName  = `__mini_tmp_${this.tmpIdx++}`;
                        const irTy     = toLLVM(currentTy);
                        const allocaTmp = `%${tmpName}`;
                        lines.push(`  ${allocaTmp} = alloca ${irTy}, align ${alignOf(currentTy)}`);
                        lines.push(`  store ${irTy} ${currentAlloca}, ${irTy}* ${allocaTmp}, align ${alignOf(currentTy)}`);
                        const tmpCtx: VarCtx = new Map(varCtx);
                        tmpCtx.set(tmpName, { allocaName: allocaTmp, llvmType: currentTy });
                        receiverVarName = tmpName;
                        // Re-dispatch with the augmented context
                        const res = this.emitMemberCallInstr(lines, receiverVarName, field, [], tmpCtx, true);
                        if (res === 'undef') return { reg: 'undef', ty: 'i8*' };
                        const retTy = this.inferMiniMethodRetTy(currentTy, field);
                        return { reg: res, ty: retTy };
                    }
                    const res = this.emitMemberCallInstr(lines, receiverVarName, field, [], varCtx, true);
                    if (res === 'undef') return { reg: 'undef', ty: 'i8*' };
                    const retTy = this.inferMiniMethodRetTy(currentTy, field);
                    // If there are more fields after this method call, we'd need to
                    // recurse, but that is an unusual pattern; return as-is for now.
                    return { reg: res, ty: retTy };
                }

                const fieldIdx = fields.findIndex(f => f.name === field);
                if (fieldIdx < 0) return { reg: 'undef', ty: 'i8*' };

                const fieldInfo  = fields[fieldIdx];
                const fieldIrTy  = toLLVM(fieldInfo.llvmType);
                const fieldAlign = alignOf(fieldInfo.llvmType);

                // Load the struct pointer from its alloca (first step) or use as-is
                let ptrVal: string;
                if (isAlloca) {
                    ptrVal = `%${this.tmpIdx++}`;
                    lines.push(`  ${ptrVal} = load ${baseTy}*, ${baseTy}** ${currentAlloca}, align 8`);
                    isAlloca = false;
                } else {
                    ptrVal = currentAlloca; // already a loaded pointer
                }

                // GEP to the field
                const gepResult = `%${this.tmpIdx++}`;
                lines.push(`  ${gepResult} = getelementptr inbounds ${baseTy}, ${baseTy}* ${ptrVal}, i32 0, i32 ${fieldIdx}`);

                // Load the field value
                const result = `%${this.tmpIdx++}`;
                lines.push(`  ${result} = load ${fieldIrTy}, ${fieldIrTy}* ${gepResult}, align ${fieldAlign}`);

                currentTy      = fieldInfo.llvmType;
                currentAlloca  = result;
                currentVarName = null; // no longer a named variable
            }

            return { reg: currentAlloca, ty: currentTy };
        }

        if (expr.kind === 'bin') {
            const { reg: lReg, ty: lTy } = this.emitMiniExpr(lines, expr.left,  varCtx);
            const { reg: rReg, ty: rTy } = this.emitMiniExpr(lines, expr.right, varCtx);
            // Promote to a common type (prefer double if either side resolves to double)
            const ty = (toLLVM(lTy) === 'double' || toLLVM(rTy) === 'double') ? 'double' : lTy;
            const irTy    = toLLVM(ty);
            const isFloat = isFloatTy(ty) || isSimdVectorTy(irTy);
            const isUint  = isUnsignedTy(ty);
            let instr: string;
            switch (expr.op) {
                case '+':  instr = isFloat ? `fadd ${irTy}` : `add ${irTy}`; break;
                case '-':  instr = isFloat ? `fsub ${irTy}` : `sub ${irTy}`; break;
                case '*':  instr = isFloat ? `fmul ${irTy}` : `mul ${irTy}`; break;
                case '/':  instr = isFloat ? `fdiv ${irTy}` : isUint ? `udiv ${irTy}` : `sdiv ${irTy}`; break;
                case '%':  instr = isFloat ? `frem ${irTy}` : isUint ? `urem ${irTy}` : `srem ${irTy}`; break;
                case '&':  instr = `and ${irTy}`; break;
                case '|':  instr = `or ${irTy}`;  break;
                case '^':  instr = `xor ${irTy}`; break;
                case '<<': instr = `shl ${irTy}`; break;
                case '>>': instr = isUint ? `lshr ${irTy}` : `ashr ${irTy}`; break;
                default:   instr = `add ${irTy}`;
            }
            const tmp = `%${this.tmpIdx++}`;
            lines.push(`  ${tmp} = ${instr} ${lReg}, ${rReg}`);
            return { reg: tmp, ty };
        }

        if (expr.kind === 'call') {
            // Free function call inside a template hole: e.g. {slug(model)}
            const argRegs = expr.args.map(a => this.emitMiniExpr(lines, a, varCtx));

            const fn = this.fnTable.get(expr.name);
            if (fn) {
                const retTy  = fn.returnType ? resolveTypeRef(fn.returnType) : 'void';
                const argStr = fn.parameters
                    .map((p, i) => `${toLLVM(resolveParamType(p))} ${argRegs[i]?.reg ?? 'undef'}`)
                    .join(', ');
                if (!retTy || retTy === 'void') {
                    lines.push(`  call void @${fn.name}(${argStr})`);
                    return { reg: '', ty: 'void' };
                }
                const result = `%${this.tmpIdx++}`;
                lines.push(`  ${result} = call ${toLLVM(retTy)} @${fn.name}(${argStr})`);
                return { reg: result, ty: retTy };
            }

            const ext = this.externTable.get(expr.name);
            if (ext) {
                const retTy  = ext.returnType ? resolveTypeRef(ext.returnType) : 'void';
                const argStr = ext.parameters
                    .map((p, i) => `${toLLVM(resolveParamType(p))} ${argRegs[i]?.reg ?? 'undef'}`)
                    .join(', ');
                if (!retTy || retTy === 'void') {
                    lines.push(`  call void @${ext.name}(${argStr})`);
                    return { reg: '', ty: 'void' };
                }
                const result = `%${this.tmpIdx++}`;
                lines.push(`  ${result} = call ${toLLVM(retTy)} @${ext.name}(${argStr})`);
                return { reg: result, ty: retTy };
            }

            lines.push(`  ; WARNING: mini-expr: unknown function '${expr.name}'`);
            return { reg: 'undef', ty: 'i8*' };
        }

        if (expr.kind === 'method_call') {
            // Method call inside a template hole: e.g. {OS.hostname()}, {GPU.isAvailable()}
            const rootInfo = varCtx.get(expr.obj);
            if (rootInfo && expr.args.length === 0) {
                // Zero-arg instance method on a known local variable — reuse existing path
                const res    = this.emitMemberCallInstr(lines, expr.obj, expr.method, [], varCtx, true);
                const retTy  = this.inferMiniMethodRetTy(rootInfo.llvmType, expr.method);
                return { reg: res, ty: retTy };
            }
            // Static type method or namespace function (obj not in varCtx, or has args)
            return this.emitMiniStaticCall(lines, expr.obj, expr.method, expr.args, varCtx);
        }

        return { reg: 'undef', ty: 'i8*' };
    }

    /**
     * Infer the LLVM return type of a zero-arg method call on a given receiver
     * type, for use inside template string holes like `{item.toString()}`.
     *
     * Returns the LLVM type string (e.g. 'i8*', 'i32').  Falls back to 'i8*'
     * for unknown methods so that convertHoleToString can still proceed.
     */
    private inferMiniMethodRetTy(receiverTy: string, method: string): string {
        // Check extension table first
        const extMethods = this.extTable.get(receiverTy);
        if (extMethods?.has(method)) {
            const entry = extMethods.get(method)!;
            return entry.method.returnType ? resolveTypeRef(entry.method.returnType) : 'void';
        }
        // Well-known built-in methods
        const irTy = toLLVM(receiverTy);
        switch (method) {
            case 'toString': return 'i8*';
            case 'length':   return (irTy === 'i8*') ? 'i32' : 'i32';
            case 'toFloat':  return 'double';
            case 'toInt':    return 'i32';
            case 'toBool':   return 'i1';
            case 'not':      return 'i1';
            case 'toNumber': return 'i32';
            default:         return 'i8*';
        }
    }

    /**
     * Emit IR for a static extension method call or namespace function call with
     * mini-expression arguments (for template string holes).
     *
     * Covers:
     *   - `{OS.hostname()}`   → staticTable dispatch
     *   - `{GPU.isAvailable()}` → staticTable dispatch
     *   - Any namespace.fn(args) if obj is registered in nsTable
     */
    private emitMiniStaticCall(
        lines:    string[],
        obj:      string,
        method:   string,
        miniArgs: MiniExpr[],
        varCtx:   VarCtx,
    ): { reg: string; ty: string } {
        const argRegs = miniArgs.map(a => this.emitMiniExpr(lines, a, varCtx));

        // ── Static extension method (e.g. OS.hostname, GPU.isAvailable) ─────────
        const staticMethods = this.staticTable.get(obj);
        if (staticMethods?.has(method)) {
            const entry       = staticMethods.get(method)!;
            const mangledName = `${entry.typeName}_${method}`;
            const selfEnv     = new Map(this.currentTypeEnv);
            selfEnv.set('Self', entry.selfLlvmTy);
            const retTy  = entry.method.returnType
                ? resolveTypeRefWithEnv(entry.method.returnType, selfEnv)
                : 'void';
            const argStr = entry.method.parameters
                .map((p, i) => `${toLLVM(resolveParamType(p))} ${argRegs[i]?.reg ?? 'undef'}`)
                .join(', ');
            if (!retTy || retTy === 'void') {
                lines.push(`  call void @${mangledName}(${argStr})`);
                return { reg: '', ty: 'void' };
            }
            const result = `%${this.tmpIdx++}`;
            lines.push(`  ${result} = call ${toLLVM(retTy)} @${mangledName}(${argStr})`);
            return { reg: result, ty: retTy };
        }

        // ── Namespace function or extern (e.g. mod.fn()) ─────────────────────────
        const mod = this.nsTable.get(obj);
        if (mod) {
            const fn = mod.program.elements.filter(isFunctionDeclaration).find(f => f.name === method);
            if (fn) {
                const retTy  = fn.returnType ? resolveTypeRef(fn.returnType) : 'void';
                const argStr = fn.parameters
                    .map((p, i) => `${toLLVM(resolveParamType(p))} ${argRegs[i]?.reg ?? 'undef'}`)
                    .join(', ');
                if (!retTy || retTy === 'void') {
                    lines.push(`  call void @${fn.name}(${argStr})`);
                    return { reg: '', ty: 'void' };
                }
                const result = `%${this.tmpIdx++}`;
                lines.push(`  ${result} = call ${toLLVM(retTy)} @${fn.name}(${argStr})`);
                return { reg: result, ty: retTy };
            }
            const ext = mod.program.elements.filter(isExternDeclaration).find(e => e.name === method);
            if (ext) {
                const retTy  = ext.returnType ? resolveTypeRef(ext.returnType) : 'void';
                const argStr = ext.parameters
                    .map((p, i) => `${toLLVM(resolveParamType(p))} ${argRegs[i]?.reg ?? 'undef'}`)
                    .join(', ');
                if (!retTy || retTy === 'void') {
                    lines.push(`  call void @${ext.name}(${argStr})`);
                    return { reg: '', ty: 'void' };
                }
                const result = `%${this.tmpIdx++}`;
                lines.push(`  ${result} = call ${toLLVM(retTy)} @${ext.name}(${argStr})`);
                return { reg: result, ty: retTy };
            }
        }

        lines.push(`  ; WARNING: mini-expr: no dispatch for '${obj}.${method}'`);
        return { reg: 'undef', ty: 'i8*' };
    }

    /**
     * Convert a value of any type to an i8* (string pointer) for template
     * string concatenation.
     */
    private convertHoleToString(lines: string[], reg: string, ty: string): string {
        const irTy = toLLVM(ty);
        switch (irTy) {
            case 'i8*': return reg;
            case 'i1': {
                // select between pre-interned raw string constants
                const res      = `%${this.tmpIdx++}`;
                const trueGep  = this.rawStringGep('true');
                const falseGep = this.rawStringGep('false');
                lines.push(`  ${res} = select i1 ${reg}, i8* ${trueGep}, i8* ${falseGep}`);
                return res;
            }
            case 'double': {
                this.usesFloatToString = true;
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = call i8* @float_to_string(double ${reg})`);
                return res;
            }
            case '%Number*': {
                // Dynamic Number — delegate to number_to_string() in runtime/number.c
                this.usesNumberToString = true;
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = call i8* @number_to_string(%Number* ${reg})`);
                return res;
            }
            default: {
                // Check if this type has a toString() method via the extension table
                const extMethods = this.extTable.get(ty) ?? this.extTable.get(irTy);
                if (extMethods?.has('toString')) {
                    const entry = extMethods.get('toString')!;
                    const res   = `%${this.tmpIdx++}`;
                    lines.push(`  ${res} = call i8* @${entry.typeName}_toString(${irTy} ${reg})`);
                    return res;
                }
                // All integer types → promote to i32 then call int_to_string
                this.usesIntToString = true;
                let promoted = reg;
                if (irTy !== 'i32') {
                    promoted = this.emitCast(lines, reg, ty, 'i32');
                }
                const res = `%${this.tmpIdx++}`;
                lines.push(`  ${res} = call i8* @int_to_string(i32 ${promoted})`);
                return res;
            }
        }
    }

    // ── Type inference ────────────────────────────────────────────────────────

    private inferType(expr: Expression, varCtx: VarCtx): string {
        if (isSelfExpression(expr)) {
            return varCtx.get('self')?.llvmType ?? 'i8*';
        }
        // self(args) — return type is the fn return type stored in self's varCtx info
        if (isSelfCallExpression(expr)) {
            return varCtx.get('self')?.fnReturnType ?? 'i8*';
        }
        if (isStringLiteral(expr))   return 'i8*';
        if (isTemplateLiteral(expr)) return 'i8*';  // template strings always yield i8*
        if (isBoolLiteral(expr))     return 'i1';
        if (isNumberLiteral(expr)) {
            const raw = (expr as NumberLiteral).value;
            return String(raw).includes('.') ? 'double' : 'i32';
        }
        if (isLambdaExpression(expr)) return FNVAL_TY;
        if (isVariableRef(expr)) {
            const name = (expr as VariableRef).ref.$refText;
            const ty = varCtx.get(name)?.llvmType;
            if (ty) return ty;
            // Named function reference
            if (this.fnTable.has(name) || this.localFnScope.has(name)) return FNVAL_TY;
            return 'i8*';
        }
        if (isFieldAccess(expr)) {
            const fa = expr as FieldAccess;
            const receiverName = fa.selfReceiver ? 'self' : (fa.receiver ?? '');
            const receiverInfo = varCtx.get(receiverName);
            if (!receiverInfo) {
                const fieldName = fa.field ?? '';

                // 1. Static property: export static PropName: T = expr
                const propEntry = fieldName ? this.staticPropsTable.get(receiverName)?.get(fieldName) : undefined;
                if (propEntry) {
                    return resolveTypeRef(propEntry.property.type);
                }

                // 2. Zero-arg static method: export static fn ConstantName(): T { ... }
                const staticMethods = this.staticTable.get(receiverName);
                if (fieldName && staticMethods?.has(fieldName)) {
                    const entry = staticMethods.get(fieldName)!;
                    if (entry.method.parameters.length === 0 && entry.method.returnType) {
                        return resolveTypeRef(entry.method.returnType);
                    }
                }
                return 'i8*';
            }
            const ptrTy  = receiverInfo.llvmType;  // e.g. "%Point*"
            const baseTy = ptrTy.replace(/\*$/, '');
            const tn     = baseTy.replace(/^%/, '');
            const fields = this.structFieldMap.get(tn);
            if (!fields) return 'i8*';
            return fields.find(f => f.name === fa.field)?.llvmType ?? 'i8*';
        }
        if (isChainedMemberCallExpr(expr)) {
            // Infer type by resolving: receiverName.field → fieldType, then fieldType.member() → returnType
            const cmce = expr as ChainedMemberCallExpr;
            const receiverName = cmce.selfCall ? 'self' : (cmce.namespace ?? '');
            const fieldTy = this.resolveFieldType(receiverName, cmce.field, varCtx);
            if (!fieldTy) return 'i8*';
            return this.typeMethodReturnType(fieldTy, cmce.member) ?? 'i8*';
        }
        if (isPostfixCallExpr(expr)) {
            // Infer type by recursively inferring receiver type, then looking up method return type.
            const pce        = expr as PostfixCallExpr;
            const receiverTy = this.inferType(pce.receiver, varCtx);
            if (!receiverTy) return 'i8*';
            // Built-in type method (e.g. Option<T>.unwrapOr → T)
            const methodTy = this.typeMethodReturnType(receiverTy, pce.member);
            if (methodTy) return methodTy;
            // Extension method
            const extMethods = this.extTable.get(receiverTy);
            if (extMethods?.has(pce.member)) {
                const entry = extMethods.get(pce.member)!;
                const retTy = entry.method.returnType ? resolveTypeRef(entry.method.returnType) : 'void';
                return retTy === 'void' ? 'i8*' : retTy;
            }
            // Generic extension method (receiver is a mangled generic type like %Option_i32*)
            const genInfo = this.mangledTypeIndex.get(receiverTy);
            if (genInfo) {
                const gEntry = this.genericExtIndex.get(genInfo.typeDecl.name)?.get(pce.member);
                if (gEntry?.method.returnType) {
                    const retTy = resolveTypeRefWithEnv(gEntry.method.returnType, genInfo.env);
                    return retTy === 'void' ? 'i8*' : retTy;
                }
            }
            // Generic enum inline method (e.g. Option<int>.unwrapOr → i32)
            const enumGenInfo = this.mangledEnumTypeIndex.get(receiverTy);
            if (enumGenInfo) {
                const enumMethod = enumGenInfo.decl.members
                    .filter(isEnumMethod)
                    .find((m: EnumMethod) => m.name === pce.member);
                if (enumMethod?.returnType) {
                    const retTy = resolveTypeRefWithEnv(enumMethod.returnType, enumGenInfo.env);
                    return retTy === 'void' ? 'i8*' : retTy;
                }
            }
            return 'i8*';
        }
        if (isCallExpression(expr)) {
            const callee = (expr as CallExpression).callee;
            // Indirect call through a fn-value variable (fat pointer)
            const fnVarInfo = varCtx.get(callee);
            if (fnVarInfo && isFnValTy(fnVarInfo.llvmType)) {
                return fnVarInfo.fnReturnType ?? 'i8*';
            }
            // Local (nested) functions take priority over module-level functions.
            const localEntry = this.localFnScope.get(callee);
            if (localEntry) {
                const ret = this.resolveReturnType(localEntry.fn, this.prePassVarCtx(localEntry.fn));
                return ret === 'void' ? 'i8*' : ret;
            }
            const fn = this.fnTable.get(callee);
            if (fn) {
                const typeParams: TypeParam[] = (fn as any).typeParams ?? [];
                if (typeParams.length > 0) {
                    // Generic function — infer concrete return type from call-site args.
                    const callArgs = (expr as CallExpression).args ?? [];
                    const ret = this.inferGenericReturnType(fn, callArgs, varCtx);
                    if (ret && ret !== 'void' && ret !== 'i8*') return ret;
                }
                const ret = this.resolveReturnType(fn, this.prePassVarCtx(fn));
                return ret === 'void' ? 'i8*' : ret;
            }
            const ext = this.externTable.get(callee);
            if (ext) {
                const ret = resolveTypeRef(ext.returnType);
                return (!ret || ret === 'void') ? 'i8*' : ret;
            }
            // Auto-generated struct constructor: TypeName_new → %TypeName*
            if (callee.endsWith('_new')) {
                const tn = callee.slice(0, -4);
                if (this.structFieldMap.has(tn)) return `%${tn}*`;
            }
            // Callable struct: TypeName(args) → return type of TypeName.call
            if (this.callableStructs.has(callee)) {
                const td   = this.structTypeDecls.get(callee);
                const body = td?.body as StructBody | undefined;
                const cm   = body?.members.find(m =>
                    (isCallableMethod(m) && (m as CallableMethod).name === 'call') ||
                    (isStructMethod(m)   && (m as StructMethod).name  === 'call' && (m as StructMethod).static),
                ) as (CallableMethod | StructMethod) | undefined;
                if (cm?.returnType) {
                    const ret = resolveTypeRefWithEnv(cm.returnType, EMPTY_ENV);
                    return ret === 'void' ? 'i8*' : ret;
                }
            }
        }
        if (isMemberCallExpression(expr)) {
            const mce = expr as MemberCallExpression;
            let mceNs = (mce as any).selfCall ? 'self' : (mce.namespace ?? '');

            // ── Generic collection alias: Map<K,V>.method() / Set<T>.method() ─
            //
            // When the receiver carries explicit type args (e.g. `Map<int,int>`)
            // and is not a local variable, resolve to the concrete type name so
            // that the static-method lookup below succeeds.
            if (!varCtx.has(mceNs) && GENERIC_COLLECTION_ALIASES.has(mceNs)) {
                const nsTypeArgs = (mce as any).nsTypeArgs as TypeReference[] | undefined;
                if (nsTypeArgs?.length) {
                    const concreteTy = resolveGenericAlias(mceNs, nsTypeArgs);
                    if (concreteTy) mceNs = llvmPtrTypeToName(concreteTy);
                }
            }

            // ── Type method call? ─────────────────────────────────────────────
            const receiverInfo = varCtx.get(mceNs);
            if (receiverInfo) {
                const methodTy = this.typeMethodReturnType(receiverInfo.llvmType, mce.member);
                if (methodTy) return methodTy;

                // ── Fat-pointer extension method (e.g. Function<A,R>.call) ───
                if (isFnValTy(receiverInfo.llvmType)) {
                    const fnExt = this.fnValExtIndex.get(mce.member);
                    if (fnExt && receiverInfo.fnParamTypes && receiverInfo.fnReturnType && isTypeDeclaration(fnExt.typeDecl)) {
                        const typeEnv = buildTypeEnvFromFnAlias(
                            fnExt.typeDecl, receiverInfo.fnParamTypes, receiverInfo.fnReturnType,
                        );
                        const retTy = fnExt.method.returnType
                            ? resolveTypeRefWithEnv(fnExt.method.returnType, typeEnv)
                            : 'void';
                        return retTy === 'void' ? 'i8*' : retTy;
                    }
                    // No declared ext — return the fn-val's return type directly
                    if (receiverInfo.fnReturnType) return receiverInfo.fnReturnType;
                }

                // ── Generic extension method on a generic type receiver ───────
                const genInfo = this.mangledTypeIndex.get(receiverInfo.llvmType);
                if (genInfo) {
                    const gEntry = this.genericExtIndex.get(genInfo.typeDecl.name)?.get(mce.member);
                    if (gEntry?.method.returnType) {
                        const retTy = resolveTypeRefWithEnv(gEntry.method.returnType, genInfo.env);
                        return retTy === 'void' ? 'i8*' : retTy;
                    }
                }
            }

            // ── Static extension method call? ────────────────────────────────
            const staticEntry = this.staticTable.get(mceNs)?.get(mce.member);
            if (staticEntry) {
                // Build Self-env so that protocol-default methods returning `Self` resolve correctly.
                const selfEnv2 = new Map<string, string>(this.currentTypeEnv);
                selfEnv2.set('Self', staticEntry.selfLlvmTy);
                const ret = staticEntry.method.returnType
                    ? resolveTypeRefWithEnv(staticEntry.method.returnType, selfEnv2)
                    : 'void';
                return ret === 'void' ? 'i8*' : ret;
            }

            // ── Namespace import call ────────────────────────────────────────
            const fn = this.fnTable.get(mce.member);
            if (fn) {
                const ret = this.resolveReturnType(fn, this.prePassVarCtx(fn));
                return ret === 'void' ? 'i8*' : ret;
            }
            const ext = this.externTable.get(mce.member);
            if (ext) {
                const ret = resolveTypeRef(ext.returnType);
                return (!ret || ret === 'void') ? 'i8*' : ret;
            }
        }
        if (isStructLiteral(expr)) {
            // Struct literal → pointer to the named struct type
            const sl = expr as StructLiteral;
            let typeName = (sl as any).selfLiteral
                ? (this.currentStructContext ?? 'Self')
                : (sl.typeName ?? 'Self');
            if (typeName === 'Self') typeName = this.currentStructContext ?? typeName;
            if (typeName && this.structFieldMap.has(typeName)) return `%${typeName}*`;
            return 'i8*';
        }
        if (isAnonymousStructLiteral(expr)) {
            // Anonymous struct literal — type is unknown without context; caller supplies expectedTy.
            return 'undef';
        }
        if (isArrayLiteral(expr)) {
            // [] or [e1, e2, ...] — type is inferred from context.
            // If elements are present, infer from the first element.
            const al = expr as ArrayLiteral;
            if (al.elements.length > 0) {
                const elemTy = this.inferType(al.elements[0], varCtx);
                return dynamicArrayLLVMType(toLLVM(elemTy));
            }
            return INTARRAY_TY; // empty: caller provides expectedTy
        }
        if (isIfExpression(expr)) {
            // Both arms must have the same type; infer from the then-arm.
            return this.inferType((expr as IfExpression).thenExpr, varCtx);
        }
        if (isSwitchExpression(expr)) {
            // Infer from the first expression arm (block arms exit via return).
            const sw = expr as SwitchExpression;
            const firstExprArm = sw.arms.find(a => a.expr);
            return firstExprArm ? this.inferType(firstExprArm.expr!, varCtx) : 'i8*';
        }
        if (isBinaryExpr(expr)) {
            const be = expr as BinaryExpr;
            // Comparison operators always return bool (i1).
            const COMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);
            if (COMP_OPS.has(be.op)) return 'i1';
            // Arithmetic / bitwise preserve the operand type; infer from left.
            return this.inferType(be.left, varCtx);
        }
        if (isUnaryExpr(expr)) {
            // -x preserves the operand type; !x always produces bool (i1)
            const ue = expr as UnaryExpr;
            return ue.op === '!' ? 'i1' : this.inferType(ue.operand, varCtx);
        }
        // Enum constructor expression: Direction::North, Shape::Circle(r)
        if (isEnumConstructor(expr)) {
            return `%${(expr as EnumConstructor).enumName}*`;
        }
        // ── Macro call expression ──────────────────────────────────────────────
        if (isMacroCallExpression(expr)) {
            const mce = expr as MacroCallExpression;
            if (mce.callee === 'size_of')   return 'i32';
            if (mce.callee === 'sizeOf')    return 'i32';
            if (mce.callee === 'alignOf')   return 'i32';
            if (mce.callee === 'offsetOf')  return 'i32';
            if (mce.callee === 'typeId')    return 'i64';
            if (mce.callee === 'dbg') {
                return mce.args.length > 0 ? this.inferType(mce.args[0], varCtx) : 'i32';
            }
            return 'i8*'; // stringify! and unknown macros return i8*
        }
        return 'i8*';
    }

    /**
     * Returns the LLVM result type for a built-in type method, or `null` if
     * the combination of (receiverLlvmType, method) is not a built-in method.
     * Must stay in sync with `emitBoolMethod`, `emitIntMethod`, `emitFloatMethod`.
     */
    private typeMethodReturnType(receiverTy: string, method: string): string | null {
        // Check extension table first
        const extMethods = this.extTable.get(receiverTy);
        if (extMethods?.has(method)) {
            const entry = extMethods.get(method)!;
            return entry.method.returnType ? resolveTypeRef(entry.method.returnType) : 'void';
        }

        // Check generic extension index for generic-type receivers
        const genInfo = this.mangledTypeIndex.get(receiverTy);
        if (genInfo) {
            const genMethods = this.genericExtIndex.get(genInfo.typeDecl.name);
            if (genMethods?.has(method)) {
                const gEntry = genMethods.get(method)!;
                const retTy = gEntry.method.returnType
                    ? resolveTypeRefWithEnv(gEntry.method.returnType, genInfo.env)
                    : 'void';
                return retTy === 'void' ? null : retTy;
            }
        }

        // Check generic enum inline methods (e.g. opt.isSome() on Option<int>)
        const enumGenInfo = this.mangledEnumTypeIndex.get(receiverTy);
        if (enumGenInfo) {
            const enumMethod = enumGenInfo.decl.members
                .filter(isEnumMethod)
                .find((m: EnumMethod) => m.name === method);
            if (enumMethod) {
                const retTy = enumMethod.returnType
                    ? resolveTypeRefWithEnv(enumMethod.returnType, enumGenInfo.env)
                    : 'void';
                return retTy === 'void' ? null : retTy;
            }
        }

        // PtrArray built-in methods (Array<StructType>)
        if (receiverTy === PTRARRAY_TY) {
            if (method === 'length') return 'i32';
            if (method === 'get')    return 'i8*';  // raw void*; caller bitcasts
            if (method === 'push' || method === 'set' || method === 'free') return 'void';
            return null;
        }

        // PtrMap built-in methods (Map with struct key or value)
        if (isAnyPtrMapTy(receiverTy)) {
            if (method === 'size' || method === 'length') return 'i32';
            if (method === 'contains') return 'i1';
            if (method === 'put' || method === 'remove' || method === 'free') return null;
            if (method === 'get') {
                // IntPtrMap/StringPtrMap/PtrPtrMap: values are void* (returned as i8*)
                if (receiverTy === INTPTRMAP_TY || receiverTy === STRINGPTRMAP_TY || receiverTy === PTRPTRMAP_TY) return 'i8*';
                // PtrIntMap: values are i32
                if (receiverTy === PTRINTMAP_TY) return 'i32';
                // PtrStringMap: values are i8*
                if (receiverTy === PTRSTRMAP_TY) return 'i8*';
            }
            return null;
        }

        switch (toLLVM(receiverTy)) {
            case 'i1':
                if (method === 'toString')  return 'i8*';
                if (method === 'toNumber')  return 'i32';
                if (method === 'not')       return 'i1';
                return null;
            case 'i32':
                if (method === 'toFloat')   return 'double';
                if (method === 'toBool')    return 'i1';
                return null;
            case 'double':
                if (method === 'toInt')     return 'i32';
                if (method === 'toBool')    return 'i1';
                return null;
            case 'i8*':
                if (method === 'length')    return 'i32';
                if (method === 'at')        return 'i8*';
                if (method === 'toString')  return 'i8*';
                return null;
            default:
                return null;
        }
    }

    private prePassVarCtx(fn: FunctionDeclaration): VarCtx {
        const ctx: VarCtx = new Map();
        for (const p of fn.parameters)
            ctx.set(p.name, { allocaName: `%${p.name}`, llvmType: resolveParamType(p) });
        for (const stmt of fn.body.statements) {
            if (isVariableDeclaration(stmt)) {
                // Use varDeclType so SMI applies consistently in the pre-pass.
                const ty = this.varDeclType(stmt, ctx);
                ctx.set(stmt.name, { allocaName: `%${stmt.name}`, llvmType: ty });
            }
            if (isUsingDeclaration(stmt)) {
                const ty = stmt.varType ? resolveTypeRef(stmt.varType) : this.inferType(stmt.value, ctx);
                ctx.set(stmt.name, { allocaName: `%${stmt.name}`, llvmType: ty });
            }
        }
        return ctx;
    }

    /**
     * Infer the concrete return type of a generic function from its call-site arguments.
     *
     * For each parameter:
     *   - If the param type is a bare type-param name (e.g. `x: T`), bind T to the
     *     inferred type of the corresponding argument.
     *   - If the param type is a function type (e.g. `f: fn(A): R`), try to extract
     *     A and R by inspecting the argument: named-function → look up in fnTable,
     *     fn-variable in varCtx → use stored fnParamTypes/fnReturnType, lambda →
     *     read explicit return type annotation.
     *
     * Returns the resolved return type, or 'void' / 'i8*' on failure.
     */
    private inferGenericReturnType(
        fn:       FunctionDeclaration,
        callArgs: Expression[],
        varCtx:   VarCtx,
    ): string {
        const env = new Map<string, string>();

        for (let i = 0; i < fn.parameters.length && i < callArgs.length; i++) {
            const p  = fn.parameters[i];
            if (!p.type) continue;
            const pt = p.type as any;

            if (pt.ref && !(pt.ref as any).ref) {
                // Bare type-param reference: `x: T` → bind T to arg's type
                const pName = pt.ref.$refText as string | undefined;
                if (pName && !env.has(pName)) {
                    env.set(pName, this.inferType(callArgs[i], varCtx));
                }
            } else if (pt.fnType) {
                // fn-typed param: `f: fn(A): R` → extract A, R from the arg
                this.inferTypeParamsFromFnArg(pt, callArgs[i], varCtx, env);
            }
        }

        if (!fn.returnType) return 'void';
        const ret = resolveTypeRefWithEnv(fn.returnType, env);
        return ret ?? 'i8*';
    }

    /**
     * Attempt to bind type-param names that appear inside a fn-type parameter
     * (`f: fn(A): R`) by inspecting the concrete argument passed at the call site.
     *
     * Handles three argument shapes:
     *   1. VariableRef whose name is in fnTable → a named module-level function
     *   2. VariableRef whose varCtx entry has fnParamTypes / fnReturnType → a fn-variable
     *   3. LambdaExpression with explicit param/return type annotations
     */
    private inferTypeParamsFromFnArg(
        paramFnType: any,
        arg:         Expression,
        varCtx:      VarCtx,
        env:         Map<string, string>,
    ): void {
        const fnParams: any[] = paramFnType.fnParams ?? [];
        const isSpread = !!paramFnType.fnSpread;

        const bindFromSignature = (paramTypes: string[], retType: string) => {
            if (isSpread) {
                // fn(...A): R — bind A to tuple (or raw type for single-param backward compat)
                const spreadName = (paramFnType.fnSpread?.ref as any)?.$refText as string | undefined;
                if (spreadName && !env.has(spreadName)) {
                    env.set(spreadName,
                        paramTypes.length === 1 ? paramTypes[0] : encodeTuple(paramTypes));
                }
            } else {
                for (let j = 0; j < fnParams.length && j < paramTypes.length; j++) {
                    const pName = (fnParams[j]?.type?.ref as any)?.$refText as string | undefined;
                    if (pName && !env.has(pName)) env.set(pName, paramTypes[j]);
                }
            }
            const retParamName = (paramFnType.fnReturnType?.ref as any)?.$refText as string | undefined;
            if (retParamName && !env.has(retParamName)) env.set(retParamName, retType);
        };

        if (isVariableRef(arg)) {
            const argName = (arg as VariableRef).ref.$refText;

            // Shape 2: fn-value variable with stored signature info
            const varInfo = varCtx.get(argName);
            if (varInfo?.fnParamTypes && varInfo.fnReturnType) {
                bindFromSignature(varInfo.fnParamTypes, varInfo.fnReturnType);
                return;
            }

            // Shape 1: named module-level function
            const argFn = this.fnTable.get(argName) ?? this.localFnScope.get(argName)?.fn;
            if (argFn) {
                const paramTypes = argFn.parameters.map(p => resolveTypeRef(p.type));
                const retType    = argFn.returnType ? resolveTypeRef(argFn.returnType) : 'void';
                bindFromSignature(paramTypes, retType);
            }
        } else if (isLambdaExpression(arg)) {
            // Shape 3: inline lambda with explicit type annotations
            const lambda = arg as LambdaExpression;
            const paramTypes = lambda.parameters.map(p => resolveTypeRef(p.type));
            const retType    = (lambda as any).returnType
                ? resolveTypeRef((lambda as any).returnType)
                : 'void';
            bindFromSignature(paramTypes, retType);
        }
    }

    private resolveReturnType(fn: FunctionDeclaration, varCtx?: VarCtx): string {
        if (fn.returnType) return resolveTypeRef(fn.returnType);
        // Fall back to typeAnnotation's return type
        const typeAnnotation = (fn as any).typeAnnotation as TypeReference | undefined;
        if (typeAnnotation) {
            const fnDetails = extractFnTypeDetails(typeAnnotation, EMPTY_ENV);
            if (fnDetails && fnDetails.returnType !== 'void') return fnDetails.returnType;
        }
        if (varCtx) {
            for (const stmt of fn.body.statements) {
                if (isReturnStatement(stmt) && stmt.value)
                    return this.inferType(stmt.value, varCtx);
            }
        }
        return 'void';
    }

    // ── Generic function specialization ───────────────────────────────────────

    /**
     * Flush pending specializations for a given generic function.
     * Called after all regular functions are emitted.
     */
    private flushPendingSpecializations(
        lines:         string[],
        fn:            FunctionDeclaration,
        exportedNames: Set<string>,
    ): void {
        for (const [mangledName, spec] of this.pendingSpecializations) {
            if (spec.fn !== fn) continue;
            this.emitGenericFunctionSpec(lines, fn, mangledName, spec.env, exportedNames);
        }
    }

    /**
     * Emit a monomorphized specialization of a generic function.
     * Called on-demand when a generic function is first called with specific type args.
     */
    private emitGenericFunctionSpec(
        lines:         string[],
        fn:            FunctionDeclaration,
        mangledName:   string,
        env:           Map<string, string>,
        exportedNames: Set<string>,
    ): void {
        if (this.emittedSpecializations.has(mangledName)) return;
        this.emittedSpecializations.add(mangledName);

        const retTy   = fn.returnType ? resolveTypeRefWithEnv(fn.returnType, env) : 'void';
        const irRetTy = toLLVM(retTy);

        const paramList = fn.parameters
            .map((p, i) => `${toLLVM(resolveTypeRefWithEnv(p.type, env))} %arg.${i}`)
            .join(', ');

        const linkage = exportedNames.has(fn.name) ? '' : 'private ';
        lines.push(`; generic specialization ${mangledName}`);
        lines.push(`define ${linkage}${irRetTy} @${mangledName}(${paramList}) {`);
        lines.push('entry:');

        // Build varCtx for the body
        const varCtx: VarCtx = new Map();
        for (let i = 0; i < fn.parameters.length; i++) {
            const p = fn.parameters[i];
            const ty = resolveTypeRefWithEnv(p.type, env);
            const irTy = toLLVM(ty);
            const alloca = `%${p.name}`;
            lines.push(`  ${alloca} = alloca ${irTy}, align ${alignOf(ty)}`);
            lines.push(`  store ${irTy} %arg.${i}, ${ptrOf(ty)} ${alloca}, align ${alignOf(ty)}`);

            if (isFnValTy(ty)) {
                // Preserve fn-signature details so indirect calls inside the body
                // know the concrete parameter/return types after type substitution.
                const fnTypeRef  = resolveFnTypeRef(p.type);
                const fnDetails  = fnTypeRef ? extractFnTypeDetails(fnTypeRef, env) : null;
                varCtx.set(p.name, {
                    allocaName:   alloca,
                    llvmType:     ty,
                    fnParamTypes: fnDetails?.paramTypes,
                    fnReturnType: fnDetails?.returnType,
                });
            } else {
                varCtx.set(p.name, { allocaName: alloca, llvmType: ty });
            }
        }
        if (fn.parameters.length > 0) lines.push('');

        const prevFnRetTy    = this.currentFnRetTy;
        const prevFnIsConst  = this.currentFnIsConst;
        const prevDefers     = this.currentDefers;
        const prevMemoG      = this.currentMemoGlobal;
        const prevMemoA      = this.currentMemoParamAlloca;
        const prevLabel      = this.currentLabel;
        const prevTmpIdx     = this.tmpIdx;
        const prevLoopStack  = this.loopStack;
        const prevTypeEnv    = this.currentTypeEnv;
        this.currentFnRetTy         = retTy;
        this.currentFnIsConst       = false;
        this.currentTypeEnv         = env;
        this.currentMemoGlobal      = null;
        this.currentMemoParamAlloca = null;
        this.currentDefers          = [];
        this.currentLabel           = 'entry';
        this.tmpIdx                 = 0;
        this.loopStack              = [];

        const hasTerminator = this.emitStatements(lines, fn.body.statements, varCtx);
        if (!hasTerminator) {
            this.flushDefers(lines, varCtx);
            if (irRetTy === 'void') {
                lines.push('  ret void');
            } else {
                lines.push(`  ret ${irRetTy} 0`);
            }
        }

        this.currentFnRetTy         = prevFnRetTy;
        this.currentFnIsConst       = prevFnIsConst;
        this.currentDefers          = prevDefers;
        this.currentMemoGlobal      = prevMemoG;
        this.currentMemoParamAlloca = prevMemoA;
        this.currentLabel           = prevLabel;
        this.tmpIdx                 = prevTmpIdx;
        this.loopStack              = prevLoopStack;
        this.currentTypeEnv         = prevTypeEnv;

        lines.push('}');
        lines.push('');
    }

    // ── Generic instantiation collection ─────────────────────────────────────

    private collectGenericInstantiations(modules: ResolvedModule[]): void {
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (isFunctionDeclaration(elem)) {
                    const fn = elem as FunctionDeclaration;
                    // Scan parameter types and return type for generic instantiations
                    for (const p of fn.parameters)
                        if (p.type) this.recordTypeRefInstantiation(p.type);
                    if (fn.returnType) this.recordTypeRefInstantiation(fn.returnType);
                    this.collectInstantiationsInBlock(fn.body);
                }
                if (isExtensionDeclaration(elem)) {
                    const extDecl = elem as ExtensionDeclaration;
                    // Skip generic extension method bodies — their T references aren't instantiations
                    const extTypeParams: TypeParam[] = (extDecl as any).typeParams ?? [];
                    if (extTypeParams.length > 0) continue;
                    for (const method of extDecl.methods) {
                        for (const p of method.parameters)
                            if (p.type) this.recordTypeRefInstantiation(p.type);
                        if (method.returnType) this.recordTypeRefInstantiation(method.returnType);
                        this.collectInstantiationsInBlock(method.body);
                    }
                }
                // ── Scan struct field types ───────────────────────────────────
                // Generic enum fields (e.g. `stacktrace: Option<Stacktrace>`) must be
                // registered here so their LLVM struct body gets emitted in the IR header.
                if (isTypeDeclaration(elem)) {
                    const typeDecl = elem as TypeDeclaration;
                    if (isStructBody(typeDecl.body)) {
                        for (const member of (typeDecl.body as StructBody).members) {
                            if (isFieldDeclaration(member))
                                this.recordTypeRefInstantiation((member as FieldDeclaration).type);
                        }
                    }
                }
                // ── Scan protocol field types ─────────────────────────────────
                if (isProtocolDeclaration(elem)) {
                    const proto = elem as ProtocolDeclaration;
                    for (const pf of proto.fields)
                        this.recordTypeRefInstantiation(pf.type);
                    // Also scan protocol default method signatures and bodies
                    for (const sig of proto.signatures) {
                        for (const p of sig.parameters)
                            if (p.type) this.recordTypeRefInstantiation(p.type);
                        if (sig.returnType) this.recordTypeRefInstantiation(sig.returnType);
                        if (sig.body) this.collectInstantiationsInBlock(sig.body);
                    }
                }
            }
        }
    }

    private collectInstantiationsInBlock(block: { statements: Statement[] }): void {
        for (const stmt of block.statements) {
            this.collectInstantiationsInStmt(stmt);
        }
    }

    private collectInstantiationsInStmt(stmt: Statement): void {
        if (isVariableDeclaration(stmt)) {
            const vd = stmt as VariableDeclaration;
            if (vd.varType) this.recordTypeRefInstantiation(vd.varType);
            if (vd.value) this.collectInstantiationsInExpr(vd.value);
        }
        if (isUsingDeclaration(stmt)) {
            const ud = stmt as UsingDeclaration;
            if (ud.varType) this.recordTypeRefInstantiation(ud.varType);
            this.collectInstantiationsInExpr(ud.value);
        }
        if (isReturnStatement(stmt) && (stmt as ReturnStatement).value) {
            this.collectInstantiationsInExpr((stmt as ReturnStatement).value!);
        }
        if (isIfStatement(stmt)) {
            const is = stmt as IfStatement;
            this.collectInstantiationsInBlock(is.thenBlock);
            if (is.elseBlock) this.collectInstantiationsInBlock(is.elseBlock);
            if (is.elseIf)   this.collectInstantiationsInStmt(is.elseIf);
        }
        if (isWhileStatement(stmt)) {
            this.collectInstantiationsInBlock((stmt as WhileStatement).body);
        }
        if (isForStatement(stmt)) {
            const fs = stmt as ForStatement;
            if (fs.init.varType) this.recordTypeRefInstantiation(fs.init.varType);
            if (fs.init.value)   this.collectInstantiationsInExpr(fs.init.value);
            this.collectInstantiationsInBlock(fs.body);
        }
    }

    private collectInstantiationsInExpr(expr: Expression): void {
        if (isCallExpression(expr)) {
            for (const arg of (expr as CallExpression).args) this.collectInstantiationsInExpr(arg);
        }
        if (isBinaryExpr(expr)) {
            const be = expr as BinaryExpr;
            this.collectInstantiationsInExpr(be.left);
            this.collectInstantiationsInExpr(be.right);
        }
        if (isUnaryExpr(expr)) {
            this.collectInstantiationsInExpr((expr as UnaryExpr).operand);
        }
    }

    private recordTypeRefInstantiation(typeRef: TypeReference): void {
        if (!typeRef.ref?.ref) return;
        const decl = typeRef.ref.ref;
        // ── Generic enum instantiation tracking ─────────────────────────────
        if (isEnumDeclaration(decl)) {
            const enumDecl = decl as EnumDeclaration;
            const eParams: TypeParam[] = enumDecl.typeParams ?? [];
            if (eParams.length > 0 && typeRef.typeArgs && typeRef.typeArgs.length > 0) {
                const mangledTy = resolveEnumDeclWithArgs(enumDecl, typeRef.typeArgs, EMPTY_ENV);
                const baseName = mangledTy.replace(/^%/, '').replace(/\*$/, '');
                if (!this.enumInstantiations.has(baseName)) {
                    const env = new Map<string, string>();
                    eParams.forEach((p, i) => {
                        if (typeRef.typeArgs![i]) {
                            env.set(p.name, resolveTypeRefWithEnv(typeRef.typeArgs![i], EMPTY_ENV));
                        }
                    });
                    this.enumInstantiations.set(baseName, { decl: enumDecl, env });
                    // Also register in mangledEnumTypeIndex for method dispatch.
                    if (!this.mangledEnumTypeIndex.has(mangledTy)) {
                        this.mangledEnumTypeIndex.set(mangledTy, { decl: enumDecl, env });
                    }
                } else if (!this.mangledEnumTypeIndex.has(mangledTy)) {
                    // enumInstantiations already has it — still ensure index is populated.
                    const existing = this.enumInstantiations.get(baseName)!;
                    this.mangledEnumTypeIndex.set(mangledTy, { decl: existing.decl, env: existing.env });
                }
            }
            return;
        }
        const params: TypeParam[] = (decl as any).typeParams ?? [];
        if (params.length === 0 || !typeRef.typeArgs || typeRef.typeArgs.length === 0) return;
        // This is a generic instantiation like Array<int> or Container<string>
        const mangledTy = resolveTypeDeclWithArgs(decl, typeRef.typeArgs, EMPTY_ENV);
        // Register the opaque struct if it looks like a generic pointer type
        if (isGenericMangledTy(mangledTy)) {
            this.genericOpaqueDecls.add(mangledTy);
            // Build and cache the TypeEnv for this instantiation so that method calls
            // on receivers of this type can be dispatched to generic extensions.
            if (!this.mangledTypeIndex.has(mangledTy)) {
                const env = new Map<string, string>();
                params.forEach((p, i) => {
                    if (typeRef.typeArgs![i]) {
                        env.set(p.name, resolveTypeRefWithEnv(typeRef.typeArgs![i], EMPTY_ENV));
                    }
                });
                this.mangledTypeIndex.set(mangledTy, { typeDecl: decl, env });
            }
        }
    }

    // ── Higher-order function support ─────────────────────────────────────────

    /**
     * Collect variables captured from the outer scope by a lambda body.
     * Returns captures in declaration order (by first VariableRef encountered).
     */
    private collectCaptures(
        stmts:         Statement[],
        ownParamNames: Set<string>,
        outerCtx:      VarCtx,
    ): Array<{ name: string; llvmType: string; allocaName: string }> {
        const ownLocals = new Set(ownParamNames);
        const captured  = new Map<string, { llvmType: string; allocaName: string }>();

        // First pass: collect all locally declared variable names in the lambda body
        const gatherLocals = (ss: Statement[]) => {
            for (const s of ss) {
                if (isVariableDeclaration(s)) ownLocals.add((s as VariableDeclaration).name);
                if (isUsingDeclaration(s))    ownLocals.add((s as UsingDeclaration).name);
                if (isForStatement(s))        ownLocals.add((s as ForStatement).init.name);
                if (isFunctionDeclaration(s)) ownLocals.add((s as FunctionDeclaration).name);
                if (isIfStatement(s)) {
                    gatherLocals((s as IfStatement).thenBlock.statements);
                    if ((s as IfStatement).elseBlock)
                        gatherLocals((s as IfStatement).elseBlock!.statements);
                }
                if (isWhileStatement(s)) gatherLocals((s as WhileStatement).body.statements);
                if (isForStatement(s))   gatherLocals((s as ForStatement).body.statements);
            }
        };
        gatherLocals(stmts);

        // Second pass: find VariableRefs that refer to outer-scope names
        const scanExpr = (e: Expression) => {
            if (!e) return;
            if (isVariableRef(e)) {
                const vname = (e as VariableRef).ref.$refText;
                if (!ownLocals.has(vname) && outerCtx.has(vname) && !captured.has(vname)) {
                    const info = outerCtx.get(vname)!;
                    captured.set(vname, { llvmType: info.llvmType, allocaName: info.allocaName });
                }
                return;
            }
            if (isBinaryExpr(e))            { scanExpr((e as BinaryExpr).left); scanExpr((e as BinaryExpr).right); }
            if (isUnaryExpr(e))             { scanExpr((e as UnaryExpr).operand); }
            if (isCallExpression(e)) {
                // The callee is an ID string (not a VariableRef node), so check it directly
                // against the outer scope to detect captured fn-value variables like f, g.
                const callee = (e as CallExpression).callee;
                if (!ownLocals.has(callee) && outerCtx.has(callee) && !captured.has(callee)) {
                    const info = outerCtx.get(callee)!;
                    captured.set(callee, { llvmType: info.llvmType, allocaName: info.allocaName });
                }
                for (const a of (e as CallExpression).args) scanExpr(a);
            }
            if (isMemberCallExpression(e)) {
                // The receiver is stored as an ID string ('namespace'), not a sub-expression.
                const mce = e as MemberCallExpression;
                const ns = mce.namespace as string | undefined;
                if (ns && !ownLocals.has(ns) && outerCtx.has(ns) && !captured.has(ns)) {
                    const info = outerCtx.get(ns)!;
                    captured.set(ns, { llvmType: info.llvmType, allocaName: info.allocaName });
                }
                for (const a of mce.args) scanExpr(a);
            }
            if (isChainedMemberCallExpr(e)) {
                // The root receiver is stored as an ID string ('namespace'), not a sub-expression.
                const cme = e as ChainedMemberCallExpr;
                const ns = cme.namespace as string | undefined;
                if (ns && !ownLocals.has(ns) && outerCtx.has(ns) && !captured.has(ns)) {
                    const info = outerCtx.get(ns)!;
                    captured.set(ns, { llvmType: info.llvmType, allocaName: info.allocaName });
                }
                for (const a of cme.args) scanExpr(a);
            }
            if (isPostfixCallExpr(e)) { scanExpr((e as PostfixCallExpr).receiver); for (const a of (e as PostfixCallExpr).args) scanExpr(a); }
            if (isSelfCallExpression(e))    { for (const a of (e as SelfCallExpression).args) scanExpr(a); }
            if (isIfExpression(e))          { scanExpr((e as IfExpression).thenExpr); scanExpr((e as IfExpression).elseExpr); }
            if (isSwitchExpression(e)) {
                const sw = e as SwitchExpression;
                scanExpr(sw.subject);
                for (const arm of sw.arms) {
                    if (arm.expr) scanExpr(arm.expr);
                    if (arm.block) for (const s of arm.block.statements) scanStmt(s);
                }
            }
            if (isFieldAccess(e))           { /* receiver is a name, not a sub-expression */ }
            if (isTemplateLiteral(e)) {
                // Template-literal holes embed variable names as raw text, not as
                // VariableRef AST nodes.  Parse the raw string and walk the resulting
                // mini-expression trees so that outer-scope variables used only inside
                // a template hole are still detected as captures.
                const parts = parseTemplateParts((e as TemplateLiteral).value);
                for (const part of parts) {
                    if (part.kind !== 'hole') continue;
                    const walkMini = (m: MiniExpr): void => {
                        if (m.kind === 'id') {
                            const vname = m.name;
                            if (!ownLocals.has(vname) && outerCtx.has(vname) && !captured.has(vname)) {
                                const info = outerCtx.get(vname)!;
                                captured.set(vname, { llvmType: info.llvmType, allocaName: info.allocaName });
                            }
                        } else if (m.kind === 'member') {
                            // Only the root object can be a captured outer-scope variable;
                            // the field names are struct member names, not local variables.
                            const vname = m.obj;
                            if (!ownLocals.has(vname) && outerCtx.has(vname) && !captured.has(vname)) {
                                const info = outerCtx.get(vname)!;
                                captured.set(vname, { llvmType: info.llvmType, allocaName: info.allocaName });
                            }
                        } else if (m.kind === 'bin') {
                            walkMini(m.left);
                            walkMini(m.right);
                        }
                        // 'num' — no variables
                    };
                    walkMini(parseMiniExpr(part.text));
                }
                return;
            }
            // Don't recurse into nested lambdas — they manage their own captures
        };
        const scanStmt = (s: Statement) => {
            if (isPrintStatement(s))                                          scanExpr((s as PrintStatement).value);
            if (isReturnStatement(s) && (s as ReturnStatement).value)         scanExpr((s as ReturnStatement).value!);
            if (isVariableDeclaration(s) && (s as VariableDeclaration).value) scanExpr((s as VariableDeclaration).value!);
            if (isAssignmentStatement(s))                                      scanExpr((s as AssignmentStatement).value);
            if (isCompoundAssignStatement(s))                                  scanExpr((s as CompoundAssignStatement).value);
            if (isCallStatement(s)) {
                // Check callee as potential captured fn-value
                const csc = s as CallStatement;
                if (!ownLocals.has(csc.callee) && outerCtx.has(csc.callee) && !captured.has(csc.callee)) {
                    const info = outerCtx.get(csc.callee)!;
                    captured.set(csc.callee, { llvmType: info.llvmType, allocaName: info.allocaName });
                }
                for (const a of csc.args) scanExpr(a);
            }
            if (isMemberCallStatement(s)) {
                // The receiver is stored as an ID string ('namespace'), not a sub-expression.
                const mcs = s as MemberCallStatement;
                const ns = mcs.namespace as string | undefined;
                if (ns && !ownLocals.has(ns) && outerCtx.has(ns) && !captured.has(ns)) {
                    const info = outerCtx.get(ns)!;
                    captured.set(ns, { llvmType: info.llvmType, allocaName: info.allocaName });
                }
                for (const a of mcs.args) scanExpr(a);
            }
            if (isChainedMemberCallStatement(s)) {
                // The root receiver is stored as an ID string ('namespace'), not a sub-expression.
                const cmcs = s as ChainedMemberCallStatement;
                const ns = cmcs.namespace as string | undefined;
                if (ns && !ownLocals.has(ns) && outerCtx.has(ns) && !captured.has(ns)) {
                    const info = outerCtx.get(ns)!;
                    captured.set(ns, { llvmType: info.llvmType, allocaName: info.allocaName });
                }
                for (const a of cmcs.args) scanExpr(a);
            }
            if (isIfStatement(s)) {
                for (const ss of (s as IfStatement).thenBlock.statements) scanStmt(ss);
                if ((s as IfStatement).elseBlock)  for (const ss of (s as IfStatement).elseBlock!.statements) scanStmt(ss);
                if ((s as IfStatement).elseIf)     scanStmt((s as IfStatement).elseIf!);
            }
            if (isWhileStatement(s)) for (const ss of (s as WhileStatement).body.statements) scanStmt(ss);
            if (isForStatement(s))   for (const ss of (s as ForStatement).body.statements) scanStmt(ss);
        };
        for (const s of stmts) scanStmt(s);

        return [...captured.entries()].map(([name, info]) => ({
            name,
            llvmType:    info.llvmType,
            allocaName:  info.allocaName,
        }));
    }

    /**
     * Emit a lambda expression as a fat-pointer value.
     * Defers the actual function definition to `this.lambdaLines`.
     */
    private emitLambdaExpr(
        lines:      string[],
        expr:       LambdaExpression,
        varCtx:     VarCtx,
        _expectedTy: string,
    ): string {
        const lambdaName = `__lambda_${this.lambdaIdx++}`;

        // Determine lambda return type.
        // Use currentTypeEnv so that type parameters from the enclosing generic
        // specialization (e.g. T=i32 when inside constant_i32) are resolved.
        let retTy = 'void';
        if (expr.returnType) {
            retTy = resolveTypeRefWithEnv(expr.returnType, this.currentTypeEnv);
        } else {
            for (const stmt of expr.body.statements) {
                if (isReturnStatement(stmt) && stmt.value) {
                    retTy = this.inferType(stmt.value, varCtx);
                    break;
                }
            }
        }

        // Resolve param types with the enclosing type env (handles T, A, R params).
        const ownParamNames = new Set(expr.parameters.map(p => p.name));
        const paramTypes: string[] = expr.parameters.map(p =>
            p.type
                ? resolveTypeRefWithEnv(p.type, this.currentTypeEnv)
                : resolveParamType(p),
        );

        // Capture analysis
        const captures = this.collectCaptures(expr.body.statements, ownParamNames, varCtx);

        // Purity check: const fn cannot capture outer variables in lambdas
        if (this.currentFnIsConst && captures.length > 0) {
            throw new Error(
                `Purity violation: lambda inside 'const fn' captures outer variable ` +
                `'${captures[0].name}' in '${this.currentFnName}'`
            );
        }

        const hasCaptures = captures.length > 0;
        let envPtrVal = 'null';

        // Helper: emit the lambda function body to a lines buffer
        const emitLambdaBody = (lLines: string[], innerVarCtx: VarCtx) => {
            // Save / reset generator state for the lambda body
            const savedTmpIdx       = this.tmpIdx;
            const savedLabel        = this.currentLabel;
            const savedFnRetTy      = this.currentFnRetTy;
            const savedFnIsConst    = this.currentFnIsConst;
            const savedFnName       = this.currentFnName;
            const savedDefers       = this.currentDefers;
            const savedLoopStack    = this.loopStack;
            const savedLocalScope   = this.localFnScope;
            const savedPendingLocal = this.pendingLocalFns;

            this.tmpIdx           = 0;
            this.currentLabel     = 'entry';
            this.currentFnRetTy   = retTy;
            this.currentFnIsConst = false;   // lambdas are not const
            this.currentFnName    = lambdaName;
            this.currentDefers    = [];
            this.loopStack        = [];
            this.localFnScope     = new Map();
            this.pendingLocalFns  = [];

            const terminated = this.emitStatements(lLines, expr.body.statements, innerVarCtx);

            if (!terminated) {
                if (retTy === 'void') lLines.push('  ret void');
                else                  lLines.push(`  ret ${toLLVM(retTy)} undef`);
            }

            // Restore state
            const pendingFromLambda = this.pendingLocalFns;
            this.tmpIdx           = savedTmpIdx;
            this.currentLabel     = savedLabel;
            this.currentFnRetTy   = savedFnRetTy;
            this.currentFnIsConst = savedFnIsConst;
            this.currentFnName    = savedFnName;
            this.currentDefers    = savedDefers;
            this.loopStack        = savedLoopStack;
            this.localFnScope     = savedLocalScope;
            this.pendingLocalFns  = savedPendingLocal;

            // Emit any local functions declared inside the lambda
            for (const { fn: localFn, mangledName } of pendingFromLambda) {
                this.emitFunction(lLines, localFn, new Set(), mangledName);
            }
        };

        if (hasCaptures) {
            this.usesMalloc = true;
            const envStructName = `%${lambdaName}_env`;

            // Emit env struct type declaration (collected into module header)
            const fieldTypes = captures.map(c => toLLVM(c.llvmType)).join(', ');
            this.envStructDecls.push(`${envStructName} = type { ${fieldTypes} }`);

            // Allocate env using the sizeof trick
            const sizePtr  = `%${this.tmpIdx++}`;
            const sizeInt  = `%${this.tmpIdx++}`;
            const envRaw   = `%${this.tmpIdx++}`;
            const envTyped = `%${this.tmpIdx++}`;
            lines.push(`  ${sizePtr}  = getelementptr ${envStructName}, ${envStructName}* null, i32 1`);
            lines.push(`  ${sizeInt}  = ptrtoint ${envStructName}* ${sizePtr} to i64`);
            lines.push(`  ${envRaw}   = call i8* @malloc(i64 ${sizeInt})`);
            lines.push(`  ${envTyped} = bitcast i8* ${envRaw} to ${envStructName}*`);

            // Store each captured variable into the env struct
            for (let ci = 0; ci < captures.length; ci++) {
                const cap  = captures[ci];
                const irTy = toLLVM(cap.llvmType);
                const val  = `%${this.tmpIdx++}`;
                const ptr  = `%${this.tmpIdx++}`;
                lines.push(`  ${val} = load ${irTy}, ${irTy}* ${cap.allocaName}, align ${alignOf(cap.llvmType)}`);
                lines.push(`  ${ptr} = getelementptr inbounds ${envStructName}, ${envStructName}* ${envTyped}, i32 0, i32 ${ci}`);
                lines.push(`  store ${irTy} ${val}, ${irTy}* ${ptr}, align ${alignOf(cap.llvmType)}`);
            }
            envPtrVal = envRaw;

            // Build the lambda function definition
            const lLines: string[] = [];
            const paramSig = paramTypes.map((pt, i) => `${toLLVM(pt)} %arg.${i}`).join(', ');
            const fullSig  = paramSig ? `${paramSig}, i8* %_env` : `i8* %_env`;
            lLines.push(`; closure lambda ${lambdaName}`);
            lLines.push(`define private ${toLLVM(retTy)} @${lambdaName}(${fullSig}) {`);
            lLines.push('entry:');

            const innerVarCtx: VarCtx = new Map();

            // Allocate lambda params
            for (let pi = 0; pi < expr.parameters.length; pi++) {
                const p  = expr.parameters[pi];
                const pt = paramTypes[pi];
                const irPt = toLLVM(pt);
                lLines.push(`  %${p.name} = alloca ${irPt}, align ${alignOf(pt)}`);
                lLines.push(`  store ${irPt} %arg.${pi}, ${irPt}* %${p.name}, align ${alignOf(pt)}`);
                innerVarCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: pt });
            }
            if (expr.parameters.length > 0) lLines.push('');

            // Load captured vars from env
            lLines.push(`  %env_typed = bitcast i8* %_env to ${envStructName}*`);
            for (let ci = 0; ci < captures.length; ci++) {
                const cap    = captures[ci];
                const irTy   = toLLVM(cap.llvmType);
                const capPtr = `%cap_${cap.name}_ptr`;
                const capVal = `%cap_${cap.name}_val`;
                const capAlloca = `%${cap.name}`;
                lLines.push(`  ${capPtr} = getelementptr inbounds ${envStructName}, ${envStructName}* %env_typed, i32 0, i32 ${ci}`);
                lLines.push(`  ${capVal} = load ${irTy}, ${irTy}* ${capPtr}, align ${alignOf(cap.llvmType)}`);
                lLines.push(`  ${capAlloca} = alloca ${irTy}, align ${alignOf(cap.llvmType)}`);
                lLines.push(`  store ${irTy} ${capVal}, ${irTy}* ${capAlloca}, align ${alignOf(cap.llvmType)}`);
                innerVarCtx.set(cap.name, {
                    allocaName:   capAlloca,
                    llvmType:     cap.llvmType,
                    fnParamTypes: varCtx.get(cap.name)?.fnParamTypes,
                    fnReturnType: varCtx.get(cap.name)?.fnReturnType,
                });
            }
            if (captures.length > 0) lLines.push('');

            emitLambdaBody(lLines, innerVarCtx);
            lLines.push('}');
            lLines.push('');
            this.lambdaLines.push(...lLines);

        } else {
            // Non-capturing lambda
            const lLines: string[] = [];
            const paramSig = paramTypes.map((pt, i) => `${toLLVM(pt)} %arg.${i}`).join(', ');
            const fullSig  = paramSig ? `${paramSig}, i8* %_env` : `i8* %_env`;
            lLines.push(`; lambda ${lambdaName} (non-capturing)`);
            lLines.push(`define private ${toLLVM(retTy)} @${lambdaName}(${fullSig}) {`);
            lLines.push('entry:');

            const innerVarCtx: VarCtx = new Map();
            for (let pi = 0; pi < expr.parameters.length; pi++) {
                const p  = expr.parameters[pi];
                const pt = paramTypes[pi];
                const irPt = toLLVM(pt);
                lLines.push(`  %${p.name} = alloca ${irPt}, align ${alignOf(pt)}`);
                lLines.push(`  store ${irPt} %arg.${pi}, ${irPt}* %${p.name}, align ${alignOf(pt)}`);
                innerVarCtx.set(p.name, { allocaName: `%${p.name}`, llvmType: pt });
            }
            if (expr.parameters.length > 0) lLines.push('');

            emitLambdaBody(lLines, innerVarCtx);
            lLines.push('}');
            lLines.push('');
            this.lambdaLines.push(...lLines);
        }

        // Create the fat pointer in the calling function
        const irRetTy  = toLLVM(retTy);
        const paramSig = paramTypes.map(pt => toLLVM(pt)).join(', ');
        const fullSig  = paramSig ? `${irRetTy} (${paramSig}, i8*)` : `${irRetTy} (i8*)`;
        const fp0 = `%${this.tmpIdx++}`;
        const fp1 = `%${this.tmpIdx++}`;
        lines.push(`  ${fp0} = insertvalue { i8*, i8* } undef, i8* bitcast (${fullSig}* @${lambdaName} to i8*), 0`);
        lines.push(`  ${fp1} = insertvalue { i8*, i8* } ${fp0}, i8* ${envPtrVal}, 1`);
        return fp1;
    }

    /**
     * Emit a named function reference as a fat-pointer value { i8*, i8* }.
     * Generates a wrapper function (once) that appends an unused i8* env parameter.
     */
    private emitFnRefValue(lines: string[], fn: FunctionDeclaration, origName: string): string {
        const wrapperName = `${origName}__fn_wrap`;

        if (!this.emittedWrappers.has(wrapperName)) {
            this.emittedWrappers.add(wrapperName);

            const fnTypeAnnotation = (fn as any).typeAnnotation as TypeReference | undefined;
            const parentFnRef      = fnTypeAnnotation ? resolveFnTypeRef(fnTypeAnnotation) : null;
            const parentFnParams: any[] = parentFnRef ? (parentFnRef as any).fnParams ?? [] : [];

            const retTy      = this.resolveReturnType(fn, this.prePassVarCtx(fn));
            const paramTypes = fn.parameters.map((p, i) => {
                if (p.type) return resolveParamType(p);
                if (i < parentFnParams.length && parentFnParams[i]?.type)
                    return resolveTypeRefWithEnv(parentFnParams[i].type as TypeReference, EMPTY_ENV);
                return resolveParamType(p);
            });

            const paramSig = paramTypes.map((pt, i) => `${toLLVM(pt)} %x${i}`).join(', ');
            const callArgs = paramTypes.map((pt, i) => `${toLLVM(pt)} %x${i}`).join(', ');
            const fullSig  = paramSig ? `${paramSig}, i8* %_env` : `i8* %_env`;

            const wLines: string[] = [];
            wLines.push(`; named fn reference wrapper for @${origName}`);
            wLines.push(`define private ${toLLVM(retTy)} @${wrapperName}(${fullSig}) {`);
            wLines.push('entry:');
            if (retTy === 'void') {
                wLines.push(`  call void @${origName}(${callArgs})`);
                wLines.push('  ret void');
            } else {
                wLines.push(`  %r = call ${toLLVM(retTy)} @${origName}(${callArgs})`);
                wLines.push(`  ret ${toLLVM(retTy)} %r`);
            }
            wLines.push('}');
            wLines.push('');
            this.wrapperLines.push(...wLines);
        }

        const retTy     = this.resolveReturnType(fn, this.prePassVarCtx(fn));
        const paramTypes = fn.parameters.map(p => resolveParamType(p));
        const paramSig  = paramTypes.map(pt => toLLVM(pt)).join(', ');
        const irRetTy   = toLLVM(retTy);
        const fullSig   = paramSig ? `${irRetTy} (${paramSig}, i8*)` : `${irRetTy} (i8*)`;

        const fp0 = `%${this.tmpIdx++}`;
        const fp1 = `%${this.tmpIdx++}`;
        lines.push(`  ${fp0} = insertvalue { i8*, i8* } undef, i8* bitcast (${fullSig}* @${wrapperName} to i8*), 0`);
        lines.push(`  ${fp1} = insertvalue { i8*, i8* } ${fp0}, i8* null, 1`);
        return fp1;
    }

    /**
     * Emit an indirect call through a function-type variable (fat pointer).
     * varInfo must have llvmType === FNVAL_TY.
     */
    private emitIndirectCallInstr(
        lines:       string[],
        callee:      string,
        args:        Expression[],
        varCtx:      VarCtx,
        varInfo:     VarInfo,
        capture:     boolean,
        expectedTy?: string,
    ): string {
        const fnParamTypes = varInfo.fnParamTypes ?? [];
        const fnReturnType = varInfo.fnReturnType ?? expectedTy ?? 'i32';
        const irRetTy = toLLVM(fnReturnType);

        // Load the fat pointer struct
        const fv = `%${this.tmpIdx++}`;
        lines.push(`  ${fv} = load { i8*, i8* }, { i8*, i8* }* ${varInfo.allocaName}, align 8`);

        // Extract fn_ptr and env_ptr
        const fnRaw = `%${this.tmpIdx++}`;
        const env   = `%${this.tmpIdx++}`;
        lines.push(`  ${fnRaw} = extractvalue { i8*, i8* } ${fv}, 0`);
        lines.push(`  ${env}   = extractvalue { i8*, i8* } ${fv}, 1`);

        // Determine the call signature
        const resolvedParamTypes: string[] = fnParamTypes.length > 0
            ? fnParamTypes
            : args.map(a => this.inferType(a, varCtx));
        const paramSig = resolvedParamTypes.map(pt => toLLVM(pt)).join(', ');
        const fullSig  = paramSig ? `${irRetTy} (${paramSig}, i8*)` : `${irRetTy} (i8*)`;

        // Cast fn_ptr to typed function pointer
        const fnTyped = `%${this.tmpIdx++}`;
        lines.push(`  ${fnTyped} = bitcast i8* ${fnRaw} to ${fullSig}*`);

        // Emit and collect argument values
        const argVals = resolvedParamTypes.map((pt, i) => {
            const v = i < args.length
                ? this.emitExpr(lines, args[i], varCtx, pt)
                : 'undef';
            return `${toLLVM(pt)} ${v}`;
        });

        // Call
        if (fnReturnType === 'void') {
            lines.push(`  call void ${fnTyped}(${[...argVals, `i8* ${env}`].join(', ')})`);
            return 'void';
        }
        const result = `%${this.tmpIdx++}`;
        lines.push(`  ${result} = call ${irRetTy} ${fnTyped}(${[...argVals, `i8* ${env}`].join(', ')})`);
        if (!capture) lines.push(`  ; indirect call result discarded`);
        return result;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── Built-in Macro Expansion ──────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Expand a macro call *statement* (assert!, todo!, unreachable!, log!,
     * static_assert!).  Returns true when the expansion is a block terminator.
     */
    private emitMacroCallStatement(
        lines:  string[],
        stmt:   MacroCallStatement,
        varCtx: VarCtx,
    ): boolean {
        const { callee, args } = stmt;
        switch (callee) {
            case 'assert':
            case 'static_assert':
                this.emitMacroAssert(lines, args, varCtx);
                return false;

            case 'todo':
                this.emitMacroPanic(lines, args, 'not yet implemented', varCtx);
                return true;

            case 'unreachable':
                this.emitMacroPanic(lines, args, 'entered unreachable code', varCtx);
                return true;

            case 'log':
                this.emitMacroLog(lines, args, varCtx);
                return false;

            // ── compile-time diagnostics ────────────────────────────────────
            case 'compileError':
                this.emitMacroCompileError(args);
                return true; // unreachable — throws before returning

            case 'compileLog':
                this.emitMacroCompileLog(lines, args);
                return false;

            default:
                lines.push(`  ; macro ${callee}! (no built-in expansion)`);
                return false;
        }
    }

    /**
     * Expand a macro call *expression* (dbg!, size_of!, stringify!).
     * Returns the LLVM register (or constant) holding the result.
     */
    private emitMacroCallExpression(
        lines:      string[],
        expr:       MacroCallExpression,
        varCtx:     VarCtx,
        expectedTy: string | undefined,
    ): string {
        const { callee, args } = expr;
        switch (callee) {
            case 'dbg':
                return this.emitMacroDbg(lines, args, varCtx, expectedTy);

            case 'size_of':
            case 'sizeOf':
                return this.emitMacroSizeOf(args);

            case 'stringify':
                return this.emitMacroStringify(args);

            // ── compile-time type layout intrinsics ─────────────────────────
            case 'alignOf':
                return this.emitMacroAlignOf(args);

            case 'offsetOf':
                return this.emitMacroOffsetOf(args);

            // ── compile-time type identity ───────────────────────────────────
            case 'typeId':
                return this.emitMacroTypeId(args);

            default:
                lines.push(`  ; macro expression ${callee}! (no built-in expansion)`);
                return 'undef';
        }
    }

    // ── assert! ───────────────────────────────────────────────────────────────
    //
    //   assert!(cond)       →  if !cond { runtime_panic("assertion failed") }
    //   assert!(cond, msg)  →  if !cond { runtime_panic(msg) }
    //
    // Emits a conditional branch; not a terminator (execution continues on ok).

    private emitMacroAssert(
        lines:  string[],
        args:   Expression[],
        varCtx: VarCtx,
    ): void {
        if (!this.externTable.has('runtime_panic')) this.needsPanicDecl = true;
        const condExpr = args[0];
        if (!condExpr) return;

        const condVal   = this.emitExpr(lines, condExpr, varCtx, 'i1');
        const okLabel   = `assert.ok.${this.tmpIdx++}`;
        const failLabel = `assert.fail.${this.tmpIdx++}`;

        lines.push(`  br i1 ${condVal}, label %${okLabel}, label %${failLabel}`);
        lines.push(`${failLabel}:`);

        let msgPtr: string;
        if (args.length >= 2) {
            msgPtr = this.emitExpr(lines, args[1], varCtx, 'i8*', /*rawString=*/true);
        } else {
            msgPtr = this.rawStringGep('assertion failed');
        }
        lines.push(`  call void @runtime_panic(i8* ${msgPtr})`);
        lines.push(`  unreachable`);
        lines.push(`${okLabel}:`);
    }

    // ── todo! / unreachable! ─────────────────────────────────────────────────
    //
    // Unconditional panic.  Always a block terminator.

    private emitMacroPanic(
        lines:      string[],
        args:       Expression[],
        defaultMsg: string,
        varCtx:     VarCtx,
    ): void {
        if (!this.externTable.has('runtime_panic')) this.needsPanicDecl = true;
        let msgPtr: string;
        if (args.length >= 1) {
            msgPtr = this.emitExpr(lines, args[0], varCtx, 'i8*', /*rawString=*/true);
        } else {
            msgPtr = this.rawStringGep(defaultMsg);
        }
        lines.push(`  call void @runtime_panic(i8* ${msgPtr})`);
        lines.push(`  unreachable`);
    }

    // ── log! ──────────────────────────────────────────────────────────────────
    //
    //   log!(level, part1, part2, ...)
    //
    // Emits a single formatted line: [level] part1 part2 …
    // Each part is evaluated to i8* then concatenated with spaces.

    private emitMacroLog(
        lines:  string[],
        args:   Expression[],
        varCtx: VarCtx,
    ): void {
        this.needsConcatDecl = !this.externTable.has('concat');

        // Ensure bracket / space raw strings are interned
        this.rawInternString('[');
        this.rawInternString(']');
        this.rawInternString(' ');

        const fmtSc = this.strMap.get('%s');
        if (!fmtSc) return; // pre-interned in collectStringsInStmt

        if (args.length === 0) {
            // No args: just print a blank line.
            const fmtPtr = `getelementptr inbounds ([${fmtSc.byteLen} x i8], [${fmtSc.byteLen} x i8]* @${fmtSc.globalName}, i32 0, i32 0)`;
            this.rawInternString('');
            const pr = `%${this.tmpIdx++}`;
            lines.push(`  ${pr} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${this.rawStringGep('')})`);
            return;
        }

        // Level is args[0]; evaluate as i8*
        const levelPtr = this.emitExpr(lines, args[0], varCtx, 'i8*', /*rawString=*/true);

        // Build "[level]" = concat("[", concat(level, "]"))
        const t1 = `%${this.tmpIdx++}`;
        lines.push(`  ${t1} = call i8* @concat(i8* ${this.rawStringGep('[')}, i8* ${levelPtr})`);
        const t2 = `%${this.tmpIdx++}`;
        lines.push(`  ${t2} = call i8* @concat(i8* ${t1}, i8* ${this.rawStringGep(']')})`);
        let acc = t2;

        // Append each remaining part: acc = concat(acc, concat(" ", part))
        for (let i = 1; i < args.length; i++) {
            const partPtr = this.emitExpr(lines, args[i], varCtx, 'i8*', /*rawString=*/true);
            const sp = `%${this.tmpIdx++}`;
            lines.push(`  ${sp} = call i8* @concat(i8* ${this.rawStringGep(' ')}, i8* ${partPtr})`);
            const t = `%${this.tmpIdx++}`;
            lines.push(`  ${t} = call i8* @concat(i8* ${acc}, i8* ${sp})`);
            acc = t;
        }

        // printf("%s\n", acc)
        const fmtPtr = `getelementptr inbounds ([${fmtSc.byteLen} x i8], [${fmtSc.byteLen} x i8]* @${fmtSc.globalName}, i32 0, i32 0)`;
        const pr = `%${this.tmpIdx++}`;
        lines.push(`  ${pr} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${acc})`);
    }

    // ── dbg! ──────────────────────────────────────────────────────────────────
    //
    //   dbg!(expr)
    //
    // Prints "dbg[<source-text>] = <value>\n" and returns the value unchanged.
    // Transparent: the return type mirrors the expression type.

    private emitMacroDbg(
        lines:      string[],
        args:       Expression[],
        varCtx:     VarCtx,
        expectedTy: string | undefined,
    ): string {
        if (args.length === 0) return 'undef';

        this.needsConcatDecl = !this.externTable.has('concat');

        const argExpr = args[0];

        // Determine value type and evaluate the expression
        const valTy = (expectedTy && expectedTy !== 'undef' && expectedTy !== 'i8*'
                        && expectedTy !== 'void')
            ? expectedTy
            : this.inferType(argExpr, varCtx);
        const val = this.emitExpr(lines, argExpr, varCtx, valTy);

        // Build the label string "dbg[<text>] = " and intern it
        const exprText = this.exprToText(argExpr);
        const labelStr = `dbg[${exprText}] = `;
        this.rawInternString(labelStr);
        const labelGep = this.rawStringGep(labelStr);

        // Convert value to i8* string for printing
        const valStr = this.convertHoleToString(lines, val, valTy);

        // concat(label, valStr) → full output string
        const fullStr = `%${this.tmpIdx++}`;
        lines.push(`  ${fullStr} = call i8* @concat(i8* ${labelGep}, i8* ${valStr})`);

        // printf("%s\n", fullStr)
        const fmtSc  = this.strMap.get('%s')!;
        const fmtPtr = `getelementptr inbounds ([${fmtSc.byteLen} x i8], [${fmtSc.byteLen} x i8]* @${fmtSc.globalName}, i32 0, i32 0)`;
        const pr     = `%${this.tmpIdx++}`;
        lines.push(`  ${pr} = call i32 (i8*, ...) @printf(i8* ${fmtPtr}, i8* ${fullStr})`);

        return val;
    }

    // ── size_of! ──────────────────────────────────────────────────────────────
    //
    //   size_of!(Type) → compile-time constant i32
    //
    // Returns the byte size of the given type as an LLVM IR integer constant.

    private emitMacroSizeOf(args: Expression[]): string {
        if (args.length === 0) return '4';
        const arg = args[0];
        const typeName = isVariableRef(arg)
            ? (arg as VariableRef).ref.$refText
            : 'int';
        return String(this.typeByteSize(typeName));
    }

    /**
     * Return the byte size of a CodeLang type name.
     * Checks user-defined structs first (summing field sizes with ABI padding),
     * then falls back to the LLVM type map / sizeOfLLVM.
     */
    private typeByteSize(typeName: string): number {
        // User-defined struct: sum field sizes with LLVM ABI padding
        const fields = this.structFieldMap.get(typeName);
        if (fields && fields.length > 0) {
            let offset = 0;
            for (const f of fields) {
                const fa = alignOf(f.llvmType);
                if (offset % fa !== 0) offset += fa - (offset % fa);
                offset += sizeOfLLVM(f.llvmType);
            }
            return offset;
        }
        // Map CodeLang type names → LLVM type names, then delegate to sizeOfLLVM
        const llvmMap: Record<string, string> = {
            'bool': 'i1', 'int': 'i32', 'float': 'double', 'string': 'i8*',
            'Int8': 'i8', 'Int16': 'i16', 'Int32': 'i32', 'Int64': 'i64',
            'UInt8': 'i8', 'UInt16': 'i16', 'UInt32': 'i32', 'UInt64': 'i64',
            'Int': 'i32', 'u8': 'i8', 'u16': 'i16', 'u32': 'i32', 'u64': 'i64',
            'Float': 'float', 'Float32': 'float', 'Float64': 'double',
            'Number': '%Number*',
        };
        return sizeOfLLVM(llvmMap[typeName] ?? typeName);
    }

    // ── alignOf! ──────────────────────────────────────────────────────────────
    //
    //   alignOf!(Type) → compile-time constant i32
    //
    // Returns the natural alignment requirement of Type in bytes.
    // Delegates to the top-level `alignOf(llvmTy)` function which already
    // handles all LLVM types; this method only needs to map the CodeLang
    // type name to an LLVM type string first.
    //
    //   alignOf!(bool)   → 1
    //   alignOf!(int)    → 4
    //   alignOf!(float)  → 4
    //   alignOf!(string) → 8   (i8* pointer)
    //   alignOf!(Point)  → max(alignment of each field)   (e.g. 4 for { i32, i32 })

    private emitMacroAlignOf(args: Expression[]): string {
        if (args.length === 0) return '4';
        const typeName = isVariableRef(args[0])
            ? (args[0] as VariableRef).ref.$refText
            : 'int';
        return String(this.typeAlignOf(typeName));
    }

    /**
     * Return the alignment requirement (in bytes) for a CodeLang type name.
     * First tries the structFieldMap (for user-defined struct types), then
     * falls back to the top-level `alignOf` helper which handles LLVM types.
     */
    private typeAlignOf(typeName: string): number {
        // User-defined struct: alignment = max alignment of its fields
        const fields = this.structFieldMap.get(typeName);
        if (fields && fields.length > 0) {
            return fields.reduce((max, f) => Math.max(max, alignOf(f.llvmType)), 1);
        }
        // Map CodeLang type names → LLVM type names, then use alignOf
        const llvmMap: Record<string, string> = {
            'bool': 'i1', 'int': 'i32', 'float': 'double', 'string': 'i8*',
            'Int8': 'i8', 'Int16': 'i16', 'Int32': 'i32', 'Int64': 'i64',
            'UInt8': 'i8', 'UInt16': 'i16', 'UInt32': 'i32', 'UInt64': 'i64',
            'Int': 'i32', 'u8': 'i8', 'u16': 'i16', 'u32': 'i32', 'u64': 'i64',
            'Float': 'float', 'Float32': 'float', 'Float64': 'double',
            'Number': '%Number*',
        };
        const llvmTy = llvmMap[typeName] ?? typeName;
        return alignOf(llvmTy);
    }

    // ── offsetOf! ─────────────────────────────────────────────────────────────
    //
    //   offsetOf!(StructType, fieldName) → compile-time constant i32
    //
    // Returns the byte offset of `fieldName` within `StructType`, accounting
    // for inter-field padding that the LLVM ABI inserts.
    //
    //   type Point { x: int; y: int }
    //   offsetOf!(Point, x)   → 0
    //   offsetOf!(Point, y)   → 4   (sizeof(i32) = 4, then y follows at +4)
    //
    //   type Mixed { flag: bool; value: int }
    //   offsetOf!(Mixed, flag)   → 0
    //   offsetOf!(Mixed, value)  → 4   (padded from offset 1 to alignment 4)

    private emitMacroOffsetOf(args: Expression[]): string {
        if (args.length < 2) return '0';
        const typeName  = isVariableRef(args[0]) ? (args[0] as VariableRef).ref.$refText : '';
        const fieldName = isVariableRef(args[1]) ? (args[1] as VariableRef).ref.$refText : '';
        return String(this.computeFieldOffset(typeName, fieldName));
    }

    /**
     * Compute the byte offset of `fieldName` within the struct named `typeName`.
     * Applies LLVM's natural-alignment padding rule between consecutive fields.
     * Returns 0 when the type or field is not found.
     */
    private computeFieldOffset(typeName: string, fieldName: string): number {
        const fields = this.structFieldMap.get(typeName);
        if (!fields) return 0;
        let offset = 0;
        for (const f of fields) {
            // Align current offset to this field's alignment before placing it
            const fa = alignOf(f.llvmType);
            if (offset % fa !== 0) offset += fa - (offset % fa);
            if (f.name === fieldName) return offset;
            // Advance past this field's storage
            const fs = sizeOfLLVM(f.llvmType);
            offset += fs;
        }
        return 0; // field not found
    }

    // ── typeId! ───────────────────────────────────────────────────────────────
    //
    //   typeId!(T) → compile-time constant i64
    //
    // Returns a stable djb2 hash of the type name as an i64 constant.
    // Two equal type names always produce the same constant.
    //
    //   typeId!(int)     → e.g. 2090452731
    //   typeId!(string)  → different constant
    //   typeId!(Point)   → hash of "Point"

    private emitMacroTypeId(args: Expression[]): string {
        if (args.length === 0) return '0';
        const typeName = isVariableRef(args[0])
            ? (args[0] as VariableRef).ref.$refText
            : 'unknown';
        return String(djb2Hash(typeName));
    }

    // ── compileError! ─────────────────────────────────────────────────────────
    //
    //   compileError!($msg: Literal)
    //
    // Aborts compilation with `msg` as the error message.
    // Semantically equivalent to C++ `static_assert(false, msg)` or
    // Zig's `@compileError`.  The macro is expanded at the point where it
    // appears; no runtime code is produced.
    //
    //   compileError!("unsupported platform");
    //   compileError!("size_of!(int) must be >= 4");

    private emitMacroCompileError(args: Expression[]): never {
        const msg = args.length > 0
            ? this.extractLiteralString(args[0]) ?? 'compile error'
            : 'compile error';
        throw new Error(`[compileError!] ${msg}`);
    }

    // ── compileLog! ───────────────────────────────────────────────────────────
    //
    //   compileLog!(...$args: Expr)
    //
    // Prints arguments during compilation (to stderr / build output).
    // Inspired by Zig's `@compileLog`.
    //
    // Like Zig, leaving a compileLog! in the code is flagged with a
    // `; compileLog` comment in the IR so the developer is reminded to remove
    // it before shipping.  Unlike Zig, CodeLang does NOT abort the build —
    // the output is purely diagnostic.
    //
    //   compileLog!("size of int =", size_of!(int));
    //   compileLog!(type_name!(T));

    private emitMacroCompileLog(lines: string[], args: Expression[]): void {
        const parts = args.map(a => this.exprToText(a));
        const msg   = parts.join(', ');
        // Print at compile time (visible in the compiler's output)
        process.stderr.write(`[compileLog!] ${msg}\n`);
        // Leave a comment in the IR so the caller is reminded to remove it
        lines.push(`  ; compileLog!: ${msg} — remove this before shipping`);
    }

    /**
     * Extract a raw string from a StringLiteral expression, or return undefined.
     * Used by compileError! to extract the error message at compile time.
     *
     * Supports:
     *   - String literals:       "some message"
     *   - Variable references:   someVar  (uses the identifier text)
     *   - Struct literals:       MyError { name: "msg", ... }
     *                            ↳ reads the `name` field's string value
     *                            so Error-protocol values work as compileError! args
     */
    private extractLiteralString(expr: Expression): string | undefined {
        if (isStringLiteral(expr)) return (expr as StringLiteral).value;
        if (isVariableRef(expr))   return (expr as VariableRef).ref.$refText;
        // Struct literal — try to read the `name` field (Error-protocol convention).
        // StructFieldInit has three shapes:
        //   named:     { name: 'fieldName', value: Expression }       → fi.name, fi.value
        //   shorthand: { shorthand: 'fieldName' }                     → (fi as any).shorthand
        //   spread:    { source: 'varName' }                          → fi.source
        if (isStructLiteral(expr)) {
            const sl = expr as StructLiteral;
            // Named field init: `name: <expr>` — recurse to extract the string
            const nameField = sl.fields.find((f: StructFieldInit) => f.name === 'name');
            if (nameField?.value) return this.extractLiteralString(nameField.value);
            // Shorthand field init: `name,` — returns the identifier itself as a
            // best-effort message (we cannot evaluate variables at compile time)
            const shorthandField = sl.fields.find(
                (f: StructFieldInit) => (f as any).shorthand === 'name'
            );
            if (shorthandField) return (shorthandField as any).shorthand as string;
        }
        return undefined;
    }

    // ── stringify! ────────────────────────────────────────────────────────────
    //
    //   stringify!(expr) → string literal of the expression's source text

    private emitMacroStringify(args: Expression[]): string {
        if (args.length === 0) {
            this.rawInternString('');
            return this.rawStringGep('');
        }
        const text = this.exprToText(args[0]);
        this.rawInternString(text);
        return this.rawStringGep(text);
    }

    // ── exprToText ────────────────────────────────────────────────────────────
    //
    // Reconstruct a compact source-text representation of an expression node.
    // Used by dbg! and stringify! for label generation.

    private exprToText(expr: Expression): string {
        if (isVariableRef(expr)) return (expr as VariableRef).ref.$refText;
        if (isNumberLiteral(expr)) return String((expr as NumberLiteral).value);
        if (isStringLiteral(expr)) return `"${(expr as StringLiteral).value}"`;
        if (isBoolLiteral(expr)) return String((expr as BoolLiteral).value);
        if (isFieldAccess(expr)) {
            const fa = expr as FieldAccess;
            const ns = fa.selfReceiver ? 'self' : (fa.receiver ?? '');
            return `${ns}.${fa.field}`;
        }
        if (isMemberCallExpression(expr)) {
            const mce = expr as MemberCallExpression;
            const ns  = mce.selfCall ? 'self' : (mce.namespace ?? '');
            const argsText = mce.args.map(a => this.exprToText(a)).join(', ');
            return `${ns}.${mce.member}(${argsText})`;
        }
        if (isPostfixCallExpr(expr)) {
            const pce      = expr as PostfixCallExpr;
            const recText  = this.exprToText(pce.receiver);
            const argsText = pce.args.map(a => this.exprToText(a)).join(', ');
            return `${recText}.${pce.member}(${argsText})`;
        }
        if (isBinaryExpr(expr)) {
            const be = expr as BinaryExpr;
            return `${this.exprToText(be.left)} ${be.op} ${this.exprToText(be.right)}`;
        }
        if (isUnaryExpr(expr)) {
            const ue = expr as UnaryExpr;
            return `${ue.op}${this.exprToText(ue.operand)}`;
        }
        if (isMacroCallExpression(expr)) {
            const mce = expr as MacroCallExpression;
            const argsText = mce.args.map(a => this.exprToText(a)).join(', ');
            return `${mce.callee}!(${argsText})`;
        }
        return '<expr>';
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── @derive(Displayable) — auto-generated toString ────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Scan all TypeDeclarations for `@derive(Displayable)` and register a
     * fake ExtensionEntry in `extTable` so that `p.toString()` dispatch finds
     * the auto-generated function.
     *
     * Called from generate() after collectEnumInfo, before function emission.
     */
    private collectDerivedDecorators(modules: ResolvedModule[]): void {
        for (const mod of modules) {
            for (const elem of mod.program.elements) {
                if (!isTypeDeclaration(elem)) continue;
                const td = elem as TypeDeclaration;
                const hasDeriveDisplayable = td.decorators.some(
                    d => d.name === 'derive' && d.args.some(a => a.identVal === 'Displayable')
                );
                if (!hasDeriveDisplayable) continue;

                const typeName   = td.name;
                const selfLlvmTy = `%${typeName}*`;

                // Pre-intern the "[TypeName]" raw string constant so that
                // emitDerivedToStringMethod can use rawStringGep() during emission.
                this.rawInternString(`[${typeName}]`);

                // Build a minimal fake TypeReference that resolves to 'i8*'.
                // resolveTypeRefWithEnv checks:
                //   1. ref?.ref → undefined  (no resolved TypeDeclaration)
                //   2. ref?.$refText → 'string'  →  env.has('string') → false
                //   3. falls through → returns 'i8*'
                const fakeReturnType = {
                    $type: 'TypeReference',
                    ref: { $refText: 'string', ref: undefined },
                    primitive: undefined,
                    tupleType: false,
                    fnType: false,
                    typeofKw: false,
                    typeArgs: [],
                } as unknown as TypeReference;

                const fakeMethod = {
                    $type:      'ExtensionMethod',
                    name:       'toString',
                    parameters: [] as Parameter[],
                    returnType: fakeReturnType,
                    export:     true,
                    static:     false,
                    comptime:   false,
                } as unknown as ExtensionMethod;

                const entry: ExtensionEntry = {
                    method:     fakeMethod,
                    typeName,
                    selfLlvmTy,
                    isStatic:   false,
                };

                if (!this.extTable.has(selfLlvmTy)) {
                    this.extTable.set(selfLlvmTy, new Map());
                }
                // Only register if not already present (explicit extension wins)
                if (!this.extTable.get(selfLlvmTy)!.has('toString')) {
                    this.extTable.get(selfLlvmTy)!.set('toString', entry);
                }
            }
        }
    }

    /**
     * Emit a simple `@TypeName_toString` function for a type decorated with
     * `@derive(Displayable)`.  Returns the string literal "[TypeName]".
     *
     *   define private i8* @Point_toString(%Point* %self.0) {
     *   entry:
     *     ret i8* getelementptr inbounds ... @.raw.N
     *   }
     */
    private emitDerivedToStringMethod(funcs: string[], typeName: string): void {
        const label = `[${typeName}]`;
        const gep   = this.rawStringGep(label);
        funcs.push(`define private i8* @${typeName}_toString(%${typeName}* %self.0) {`);
        funcs.push(`entry:`);
        funcs.push(`  ret i8* ${gep}`);
        funcs.push(`}`);
        funcs.push('');
    }
}

// ── String encoding ───────────────────────────────────────────────────────────

/**
 * Encode a CodeLang string literal as an LLVM IR byte-string constant.
 *
 * Rules:
 *  - The source string is first converted to UTF-8 bytes so that all Unicode
 *    code-points (Cyrillic, CJK, emoji, …) are handled correctly.
 *  - Printable ASCII bytes (0x20–0x7E) that are not `"` or `\` are emitted
 *    verbatim; every other byte is emitted as a 2-digit `\XX` hex escape.
 *  - A trailing `\0A\00` (newline + NUL) is appended so that the string can
 *    be passed directly as the format argument to `printf`.
 *
 * Why not `charCodeAt`?
 *   `charCodeAt` returns a UTF-16 code unit (up to 4 hex digits for non-BMP
 *   codepoints).  LLVM requires exactly 2-digit hex escapes, so anything
 *   above U+00FF would silently corrupt the constant.
 */
function encodeLLVMString(inner: string): { llvmEncoded: string; byteLen: number } {
    const utf8 = Buffer.from(inner, 'utf8');
    let encoded = '';
    for (const byte of utf8) {
        if (byte >= 0x20 && byte <= 0x7E && byte !== 0x22 /* " */ && byte !== 0x5C /* \ */) {
            encoded += String.fromCharCode(byte);
        } else {
            encoded += '\\' + byte.toString(16).padStart(2, '0').toUpperCase();
        }
    }
    encoded += '\\0A\\00';                        // newline + NUL terminator
    return { llvmEncoded: encoded, byteLen: utf8.length + 2 };
}

/**
 * Like `encodeLLVMString` but without a trailing newline — only a NUL
 * terminator.  Used for strings passed as function arguments rather than
 * directly printed via printf.
 */
function encodeRawLLVMString(inner: string): { llvmEncoded: string; byteLen: number } {
    const utf8 = Buffer.from(inner, 'utf8');
    let encoded = '';
    for (const byte of utf8) {
        if (byte >= 0x20 && byte <= 0x7E && byte !== 0x22 && byte !== 0x5C) {
            encoded += String.fromCharCode(byte);
        } else {
            encoded += '\\' + byte.toString(16).padStart(2, '0').toUpperCase();
        }
    }
    encoded += '\\00';                             // NUL terminator only
    return { llvmEncoded: encoded, byteLen: utf8.length + 1 };
}
