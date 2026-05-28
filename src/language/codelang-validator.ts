/**
 * CodeLang semantic validator.
 *
 * Rules implemented here:
 *
 *  1. const fn purity
 *     A `const fn` (non-main) must not call runtime side-effects like print().
 *
 *  2. const variable immutability
 *     A variable declared with `const` cannot be re-assigned.
 *
 *  3. const parameter immutability
 *     A parameter declared with `const` cannot be assigned to inside the body.
 *
 *  4. const requires initializer
 *     `const x: string` (no value) is illegal — const bindings must be set
 *     at declaration time.
 *
 *  5. protocol conformance
 *     Every method signature in a protocol that has no default body must be
 *     implemented by the extending type with a matching return type and
 *     parameter types.
 */

import type { AstNode } from 'langium';
import type { LangiumDocuments } from 'langium';
import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type {
    AssignmentStatement,
    CallableMethod,
    ExtensionDeclaration,
    ExtensionMethod,
    FunctionDeclaration,
    LambdaExpression,
    MethodSignature,
    PrintStatement,
    ReturnStatement,
    StructMethod,
    TypeReference,
    VariableDeclaration,
} from './generated/ast.js';
import type { CodeLangDiagnosticData } from '../cli/error-format.js';
import {
    isCallableMethod,
    isExtensionMethod,
    isFunctionDeclaration,
    isLambdaExpression,
    isProtocolDeclaration,
    isPrintStatement,
    isStructMethod,
    isVariableDeclaration,
    isParameter,
} from './generated/ast.js';
import type { CodeLangAstType } from './generated/ast.js';
import type { CodeLangServices } from './codelang-module.js';

// ── Type-name helpers ─────────────────────────────────────────────────────────

/**
 * Return a human-readable name for a TypeReference as it appears in source,
 * e.g. `"void"`, `"int"`, `"Option<string>"`, `"fn(...)"`.
 * Used for equality comparisons in rule 5.
 */
function typeRefName(ref: TypeReference | undefined): string {
    if (!ref) return 'void';
    if (ref.primitive === 'void') return 'void';
    if ((ref as any).selfType)   return 'Self';
    if ((ref as any).fnType)     return 'fn(...)';
    if ((ref as any).tupleType)  return 'tuple';

    // Named type: int, string, Number, MathError, …
    const refText = (ref.ref as any)?.$refText as string | undefined;
    if (refText) {
        const args: TypeReference[] = (ref as any).typeArgs ?? [];
        return args.length > 0
            ? `${refText}<${args.map(typeRefName).join(', ')}>`
            : refText;
    }
    return '?';
}

// ── Generic-aware type-name helpers ──────────────────────────────────────────

/**
 * Like `typeRefName` but substitutes protocol type-parameter names using the
 * caller-supplied map (e.g. `{ 'N' → 'int' }` for `Countable<int>`).
 * Leaf names that are NOT in the map are left unchanged (concrete type names).
 */
function typeRefNameWithSubst(
    ref: TypeReference | undefined,
    subst: ReadonlyMap<string, string>,
): string {
    if (!ref) return 'void';
    if (ref.primitive === 'void') return 'void';
    if ((ref as any).selfType)   return 'Self';
    if ((ref as any).fnType)     return 'fn(...)';
    if ((ref as any).tupleType)  return 'tuple';

    const refText = (ref.ref as any)?.$refText as string | undefined;
    if (refText) {
        const args: TypeReference[] = (ref as any).typeArgs ?? [];
        if (args.length > 0) {
            // e.g. Option<T> — recursively substitute inside the args
            return `${refText}<${args.map(a => typeRefNameWithSubst(a, subst)).join(', ')}>`;
        }
        // Bare name: substitute if it is a type parameter, otherwise keep as-is
        return subst.get(refText) ?? refText;
    }
    return '?';
}

/**
 * Return true if `ref` (or any of its type arguments) is a type parameter that
 * has NOT been given an explicit binding in `substMap`.
 *
 * This is used to decide whether a type-check can be performed statically:
 *   - Bound type param (e.g. N → int): check CAN be done after substitution.
 *   - Unbound type param (e.g. T with no arg supplied): skip the check to
 *     avoid false positives.
 */
function containsUnboundTypeParam(
    ref: TypeReference | undefined,
    substMap: ReadonlyMap<string, string>,
    typeParamNames: ReadonlySet<string>,
): boolean {
    if (!ref) return false;
    const refText = (ref.ref as any)?.$refText as string | undefined;
    if (!refText) return false;
    if (typeParamNames.has(refText) && !substMap.has(refText)) return true;
    const args: TypeReference[] = (ref as any).typeArgs ?? [];
    return args.some(a => containsUnboundTypeParam(a, substMap, typeParamNames));
}

// ── Return-value type name helper ─────────────────────────────────────────────

/**
 * Infer a rough human-readable type name from a ReturnStatement's value
 * for use in help messages — just enough to be useful without running the
 * full type inference engine.
 */
function inferredReturnTypeName(stmt: ReturnStatement): string {
    const val = stmt.value;
    if (!val) return 'void';
    const t = (val as any).$type as string | undefined;
    if (t === 'NumberLiteral')                         return 'int';
    if (t === 'StringLiteral' || t === 'TemplateLiteral') return 'string';
    if (t === 'BoolLiteral')                           return 'bool';
    return '<T>';
}

// ── Enclosing-callable helper ─────────────────────────────────────────────────

/** All node types that can directly own a return statement (have a returnType). */
type AnyCallable = FunctionDeclaration | ExtensionMethod | CallableMethod | StructMethod | LambdaExpression;

/**
 * Walk up the $container chain from `node` to find the nearest enclosing
 * function, method, or lambda expression.  Returns `undefined` if none is found.
 *
 * LambdaExpression MUST be included — otherwise `return` inside an inline
 * lambda is attributed to the outer function (e.g. main), producing false
 * "cannot return value from void function" errors.
 */
function findEnclosingCallable(node: AstNode): AnyCallable | undefined {
    let cur: AstNode | undefined = (node as AstNode & { $container?: AstNode }).$container;
    while (cur) {
        if (
            isLambdaExpression(cur)    ||
            isFunctionDeclaration(cur) ||
            isExtensionMethod(cur)     ||
            isCallableMethod(cur)      ||
            isStructMethod(cur)
        ) {
            return cur as AnyCallable;
        }
        cur = (cur as AstNode & { $container?: AstNode }).$container;
    }
    return undefined;
}

// ── Validator ─────────────────────────────────────────────────────────────────

export class CodeLangValidator {

    private readonly _services: CodeLangServices;

    constructor(services: CodeLangServices) {
        this._services = services;
    }

    private get langiumDocuments(): LangiumDocuments {
        return this._services.shared.workspace.LangiumDocuments;
    }

    // ── Rule 1: const fn purity ───────────────────────────────────────────────

    checkConstFnPurity(
        fn: FunctionDeclaration,
        accept: ValidationAcceptor,
    ): void {
        if (fn.name === 'main') return; // entry point is always runtime
        if (!fn.comptime) return;
        if (!fn.body) return; // guard: parse errors can produce partial nodes

        for (const stmt of fn.body.statements) {
            if (isPrintStatement(stmt)) {
                accept('error',
                    '`print()` is a runtime side-effect and cannot appear inside a `const fn`.',
                    {
                        node: stmt as PrintStatement,
                        data: {
                            note: `Function '${fn.name}' is declared 'const', so it may only perform compile-time operations.`,
                            help: `Remove 'const' from the function declaration to allow runtime side-effects, or replace print() with a compile-time operation.`,
                        } satisfies CodeLangDiagnosticData,
                    });
            }
        }
    }

    // ── Rule 2: void return value ─────────────────────────────────────────────
    //
    // A function or method declared with return type `void` (or with no return
    // type annotation, which also means void) must not contain `return <expr>`.
    // Bare `return;` is fine.

    checkVoidReturn(
        stmt: ReturnStatement,
        accept: ValidationAcceptor,
    ): void {
        // Bare `return;` — always legal.
        if (stmt.value === undefined) return;

        const fn = findEnclosingCallable(stmt as AstNode);
        if (!fn) return; // defensive: not inside a callable

        // Functions with a non-void return type are fine.
        if (typeRefName(fn.returnType) !== 'void') return;

        // `fn name: TypeAlias(...)` — the return type lives inside the referenced
        // type alias, not on fn.returnType.  We cannot fully resolve the alias here
        // without the type-inference engine, so we conservatively skip the check to
        // avoid false "return type is void" errors on valid type-alias-annotated fns.
        if (isFunctionDeclaration(fn) && (fn as any).typeAnnotation !== undefined) return;

        const fnName = (fn as { name?: string }).name ?? '<anonymous>';
        const retTypeSrc = fn.returnType
            ? `'${typeRefName(fn.returnType)}'`
            : `'void' (no return type annotation)`;

        accept('error',
            `Cannot return a value from function '${fnName}': return type is void.`,
            {
                node: stmt,
                property: 'value',
                data: {
                    note: `'${fnName}' is declared with return type ${retTypeSrc}, so it must not return a value.`,
                    help: `Either remove the return value (use bare 'return;'), or change the function signature to return '${inferredReturnTypeName(stmt)}'.`,
                } satisfies CodeLangDiagnosticData,
            });
    }

    // ── Rule 3 & 4: const immutability (variables + parameters) ──────────────

    checkConstAssignment(
        stmt: AssignmentStatement,
        accept: ValidationAcceptor,
    ): void {
        const target = stmt.target.ref;
        if (!target) return; // unresolved reference — linking error handles it

        if (isVariableDeclaration(target) && !target.mutable) {
            accept('error',
                `Cannot assign to '${target.name}': it is declared as 'const' (immutable binding).`,
                {
                    node: stmt,
                    data: {
                        note: `'${target.name}' was declared with 'const', which prevents reassignment.`,
                        help: `Declare '${target.name}' with 'let' instead of 'const' to make it mutable.`,
                    } satisfies CodeLangDiagnosticData,
                });
            return;
        }

        if (isParameter(target) && target.immutable) {
            accept('error',
                `Cannot assign to '${target.name}': it is a 'const' parameter.`,
                {
                    node: stmt,
                    data: {
                        note: `The parameter '${target.name}' was marked 'const', preventing any reassignment inside the function.`,
                        help: `Remove 'const' from the parameter declaration if the value needs to change.`,
                    } satisfies CodeLangDiagnosticData,
                });
        }
    }

    // ── Rule 4: const must be initialized ────────────────────────────────────

    checkConstInitialized(
        decl: VariableDeclaration,
        accept: ValidationAcceptor,
    ): void {
        if (!decl.mutable && decl.value === undefined) {
            accept('error',
                `'const' binding '${decl.name}' must be initialized at declaration.`,
                {
                    node: decl,
                    property: 'name',
                    data: {
                        note: `'const' bindings are immutable and must be assigned a value immediately — they cannot be left uninitialized.`,
                        help: `Use 'let' for a mutable variable, or provide an initializer: const ${decl.name} = <value>`,
                    } satisfies CodeLangDiagnosticData,
                });
        }
    }

    // ── Rule 5: protocol conformance ─────────────────────────────────────────

    checkProtocolConformance(
        extDecl: ExtensionDeclaration,
        accept: ValidationAcceptor,
    ): void {
        if (!extDecl.protocol) return;

        const protocolName = extDecl.protocol;
        const typeName = (extDecl.typeName as any)?.$refText
            ?? extDecl.typeName?.ref?.name
            ?? '?';

        // 1. Search the same file first (most common case).
        const sameFileProtocol = extDecl.$container?.elements
            ?.filter(isProtocolDeclaration)
            .find(p => p.name === protocolName);

        // 2. Fall back to all other loaded documents (imported protocols).
        let protocolDecl = sameFileProtocol;
        if (!protocolDecl) {
            for (const doc of this.langiumDocuments.all) {
                const program = doc.parseResult?.value as any;
                const elements: unknown[] = program?.elements ?? [];
                const found = elements
                    .filter(isProtocolDeclaration)
                    .find(p => p.name === protocolName);
                if (found) {
                    protocolDecl = found;
                    break;
                }
            }
        }

        if (!protocolDecl) {
            // Protocol not loaded yet (unresolved import) — skip to avoid false positives.
            return;
        }

        // ── Build the type-parameter substitution map ─────────────────────────
        //
        // Example: `string extends Countable<int>`
        //   protocolDecl.typeParams = [TypeParam { name: 'N' }]
        //   extDecl.protocolTypeArgs = [TypeRef('int')]
        //   → substMap = { 'N' → 'int' }
        //
        // When no type args are supplied (e.g. `IntSet extends Countable`),
        // substMap is empty and N is "unbound".
        const typeParamNames = new Set<string>(
            (protocolDecl.typeParams ?? []).map((p: any) => p.name as string)
        );
        const substMap = new Map<string, string>();
        const rawTypeArgs: TypeReference[] = (extDecl as any).protocolTypeArgs ?? [];
        rawTypeArgs.forEach((arg, i) => {
            const paramName = (protocolDecl!.typeParams ?? [])[i];
            if (paramName) {
                substMap.set((paramName as any).name as string, typeRefName(arg));
            }
        });

        // ── Helper: human-readable signature with type params substituted ──────
        const sigStr = (sig: MethodSignature): string => {
            const paramList = sig.parameters
                .map(p => `${p.name}: ${typeRefNameWithSubst(p.type, substMap)}`)
                .join(', ');
            const retStr = typeRefNameWithSubst(sig.returnType, substMap);
            return retStr === 'void'
                ? `fn ${sig.name}(${paramList})`
                : `fn ${sig.name}(${paramList}): ${retStr}`;
        };

        // 3. Validate every required signature (no default body).
        for (const sig of protocolDecl.signatures) {
            if (sig.body !== undefined) continue; // default implementation → optional

            const impl = extDecl.methods.find(m => m.name === sig.name);

            if (!impl) {
                const proto = sigStr(sig);
                accept('error',
                    `Type '${typeName}' does not implement required method '${sig.name}' from protocol '${protocolName}'.`,
                    {
                        node: extDecl,
                        data: {
                            note: `Protocol '${protocolName}' requires: ${proto}`,
                            help: `Add the missing method to the '${typeName} extends ${protocolName}' block:\n       export ${proto} { ... }`,
                        } satisfies CodeLangDiagnosticData,
                    });
                continue;
            }

            // ── Return type check ─────────────────────────────────────────────
            // After substituting bound type params, compare the two sides.
            // Skip when:
            //  - the protocol return type contains an *unbound* type parameter
            //    (no explicit arg was supplied → cannot verify), OR
            //  - the protocol return type is 'Self' (the implementing type acts
            //    as a covariant stand-in — e.g. BitAnd, BinaryAdd).
            const sigRet  = typeRefNameWithSubst(sig.returnType, substMap);
            const implRet = typeRefName(impl.returnType);
            if (
                sigRet !== implRet &&
                sigRet !== 'Self' &&
                !containsUnboundTypeParam(sig.returnType, substMap, typeParamNames)
            ) {
                accept('error',
                    `Protocol conformance error: method '${sig.name}' return type mismatch.`,
                    {
                        node: impl,
                        property: impl.returnType ? 'returnType' : 'name',
                        data: {
                            note: `'${typeName}' declares '${implRet}' but protocol '${protocolName}' requires '${sigRet}'.`,
                            help: `Change the return type of '${sig.name}' from '${implRet}' to '${sigRet}'.`,
                        } satisfies CodeLangDiagnosticData,
                    });
            }

            // ── Parameter count check ─────────────────────────────────────────
            const sigParams  = sig.parameters;
            const implParams = impl.parameters;
            if (sigParams.length !== implParams.length) {
                const paramList = sigParams
                    .map(p => `${p.name}: ${typeRefNameWithSubst(p.type, substMap)}`)
                    .join(', ');
                accept('error',
                    `Protocol conformance error: method '${sig.name}' parameter count mismatch.`,
                    {
                        node: impl,
                        property: 'name',
                        data: {
                            note: `'${typeName}' has ${implParams.length} parameter(s) but protocol '${protocolName}' requires ${sigParams.length}.`,
                            help: `Update the method signature to match the protocol: fn ${sig.name}(${paramList})`,
                        } satisfies CodeLangDiagnosticData,
                    });
                continue;
            }

            // ── Per-parameter type check ──────────────────────────────────────
            for (let i = 0; i < sigParams.length; i++) {
                const sigP      = sigParams[i];
                const implP     = implParams[i];
                const sigPType  = typeRefNameWithSubst(sigP.type, substMap);
                const implPType = typeRefName(implP.type);
                // Skip when the protocol parameter type is:
                //  - an *unbound* type parameter — needs more args to verify
                //  - 'Self' — implementation substitutes the concrete type (e.g. Ord)
                if (
                    sigPType !== implPType &&
                    !containsUnboundTypeParam(sigP.type, substMap, typeParamNames) &&
                    sigPType !== 'Self'
                ) {
                    accept('error',
                        `Protocol conformance error: method '${sig.name}' parameter '${implP.name}' type mismatch.`,
                        {
                            node: implP,
                            property: 'type',
                            data: {
                                note: `Parameter '${implP.name}' has type '${implPType}' but protocol '${protocolName}' requires '${sigPType}'.`,
                                help: `Change the type of parameter '${implP.name}' from '${implPType}' to '${sigPType}'.`,
                            } satisfies CodeLangDiagnosticData,
                        });
                }
            }
        }
    }

}

export function registerValidationChecks(services: CodeLangServices): void {
    const registry  = services.validation.ValidationRegistry;
    const validator = services.validation.CodeLangValidator;

    const checks: ValidationChecks<CodeLangAstType> = {
        FunctionDeclaration:  validator.checkConstFnPurity.bind(validator),
        AssignmentStatement:  validator.checkConstAssignment.bind(validator),
        VariableDeclaration:  validator.checkConstInitialized.bind(validator),
        ExtensionDeclaration: validator.checkProtocolConformance.bind(validator),
        ReturnStatement:      validator.checkVoidReturn.bind(validator),
    };
    registry.register(checks, validator);
}
