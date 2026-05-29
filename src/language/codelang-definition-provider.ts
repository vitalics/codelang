/**
 * CodeLang Go-to-Definition provider.
 *
 * Langium's DefaultDefinitionProvider already handles every Langium cross-reference
 * (VariableRef.ref, TypeReference.ref / .elemRef, ExtensionDeclaration.typeName,
 * AssignmentStatement.target, CompoundAssignStatement.target).
 *
 * This class extends that with resolution for the many plain-string identifier
 * fields that the grammar stores as bare `ID` tokens (no `[Ref]` cross-reference):
 *
 *   • callee        — function / type / enum call sites
 *   • namespace     — "Type" in "Type.method()"
 *   • member        — method name after "."
 *   • firstMember   — first chained member in MemberCallMemberCall nodes
 *   • enumName      — "Enum" in "Enum.Variant(...)"
 *   • variant       — "Variant" in "Enum.Variant(...)" / switch patterns
 *   • typeName      — type name in struct literals  "Foo { … }"
 */

import type { AstNode, LangiumDocument, MaybePromise } from 'langium';
import { CstUtils } from 'langium';
import { DefaultDefinitionProvider } from 'langium/lsp';
import type { LangiumServices } from 'langium/lsp';
import type { LeafCstNode, LangiumDocuments } from 'langium';
import { LocationLink } from 'vscode-languageserver';
import type { DefinitionParams } from 'vscode-languageserver';

import {
    isCallExpression,
    isCallMemberCallExpr,
    isCallMemberCallStatement,
    isCallMemberMemberCallExpr,
    isCallMemberMemberCallStatement,
    isCallStatement,
    isChainedMemberCallExpr,
    isChainedMemberCallStatement,
    isEnumConstructor,
    isEnumDeclaration,
    isEnumMethod,
    isEnumPattern,
    isEnumVariant,
    isExtensionDeclaration,
    isFunctionDeclaration,
    isMemberCallExpression,
    isMemberCallMemberCallExpr,
    isMemberCallMemberCallStatement,
    isMemberCallStatement,
    isProgram,
    isStructBody,
    isStructLiteral,
    isStructMethod,
    isSuperCallExpression,
    isSuperCallStatement,
    isTypeDeclaration,
} from './generated/ast.js';

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

export class CodeLangDefinitionProvider extends DefaultDefinitionProvider {
    private readonly docs: LangiumDocuments;

    constructor(services: LangiumServices) {
        super(services);
        this.docs = services.shared.workspace.LangiumDocuments;
    }

    override getDefinition(
        document: LangiumDocument,
        params: DefinitionParams,
    ): MaybePromise<LocationLink[] | undefined> {
        // 1. Langium default: resolves all cross-references (VariableRef, TypeReference, etc.)
        const defaultResult = super.getDefinition(document, params) as LocationLink[] | undefined;
        if (defaultResult && defaultResult.length > 0) {
            return defaultResult;
        }

        // 2. Custom: resolve plain-string identifier fields
        return this.resolvePlainIdents(document, params);
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    private resolvePlainIdents(
        document: LangiumDocument,
        params: DefinitionParams,
    ): LocationLink[] | undefined {
        const root = document.parseResult.value;
        if (!root.$cstNode) return undefined;

        const offset = document.textDocument.offsetAt(params.position);
        const leaf = CstUtils.findDeclarationNodeAtOffset(
            root.$cstNode,
            offset,
            this.grammarConfig.nameRegexp,
        );
        if (!leaf) return undefined;

        const el  = leaf.astNode;
        const txt = leaf.text;

        // ── callee: function / type / enum name at a call site ──────────────
        if (
            (isCallExpression(el) || isCallStatement(el) ||
             isCallMemberCallExpr(el) || isCallMemberCallStatement(el) ||
             isCallMemberMemberCallExpr(el) || isCallMemberMemberCallStatement(el))
            && el.callee === txt
        ) {
            return this.lookupFunctionOrType(txt, leaf);
        }

        // ── namespace: "Type" in "Type.method(arg)" ─────────────────────────
        if (
            (isMemberCallExpression(el) || isMemberCallStatement(el) ||
             isMemberCallMemberCallExpr(el) || isMemberCallMemberCallStatement(el) ||
             isChainedMemberCallExpr(el) || isChainedMemberCallStatement(el))
            && el.namespace === txt
        ) {
            return this.lookupTypeOrEnum(txt, leaf);
        }

        // ── member: method name ──────────────────────────────────────────────
        if (
            (isMemberCallExpression(el) || isMemberCallStatement(el)) &&
            el.member === txt
        ) {
            return this.lookupMethod(txt, el.namespace, leaf);
        }
        if (
            (isChainedMemberCallExpr(el) || isChainedMemberCallStatement(el)) &&
            el.member === txt
        ) {
            return this.lookupMethod(txt, el.namespace, leaf);
        }
        if (isMemberCallMemberCallExpr(el) || isMemberCallMemberCallStatement(el)) {
            if (el.firstMember === txt) return this.lookupMethod(txt, el.namespace, leaf);
            if (el.member === txt)      return this.lookupMethod(txt, undefined,    leaf);
        }
        if (
            (isCallMemberCallExpr(el) || isCallMemberCallStatement(el)) &&
            el.member === txt
        ) {
            // method on callee()'s return type — search all methods by name
            return this.lookupMethod(txt, undefined, leaf);
        }

        // ── enum constructor  Enum.Variant(...) ─────────────────────────────
        if (isEnumConstructor(el)) {
            if (el.enumName === txt) return this.lookupEnum(txt, leaf);
            if (el.variant  === txt) return this.lookupVariant(el.enumName, txt, leaf);
        }

        // ── enum pattern  Enum.Variant(bindings) in switch arm ──────────────
        if (isEnumPattern(el)) {
            if (el.enumName === txt) return this.lookupEnum(txt, leaf);
            if (el.variant  === txt) return this.lookupVariant(el.enumName, txt, leaf);
        }

        // ── struct literal  Foo { … } ───────────────────────────────────────
        if (isStructLiteral(el) && el.typeName === txt) {
            return this.lookupTypeOrEnum(txt, leaf);
        }

        // ── super.method() / self.method() ──────────────────────────────────
        if (
            (isSuperCallExpression(el) || isSuperCallStatement(el)) &&
            el.member === txt
        ) {
            return this.lookupMethod(txt, undefined, leaf);
        }

        return undefined;
    }

    // -----------------------------------------------------------------------
    // Lookup helpers
    // -----------------------------------------------------------------------

    /** Functions, type declarations, and enum declarations by name. */
    private lookupFunctionOrType(name: string, source: LeafCstNode): LocationLink[] {
        const links: LocationLink[] = [];
        for (const doc of this.docs.all) {
            const prog = doc.parseResult.value;
            if (!isProgram(prog)) continue;
            for (const elem of prog.elements) {
                if (
                    (isFunctionDeclaration(elem) && elem.name === name) ||
                    (isTypeDeclaration(elem)     && elem.name === name) ||
                    (isEnumDeclaration(elem)     && elem.name === name)
                ) {
                    const link = this.buildLink(elem, source, doc);
                    if (link) links.push(link);
                }
            }
        }
        return links;
    }

    /** Type and enum declarations by name. */
    private lookupTypeOrEnum(name: string, source: LeafCstNode): LocationLink[] {
        const links: LocationLink[] = [];
        for (const doc of this.docs.all) {
            const prog = doc.parseResult.value;
            if (!isProgram(prog)) continue;
            for (const elem of prog.elements) {
                if (
                    (isTypeDeclaration(elem) && elem.name === name) ||
                    (isEnumDeclaration(elem) && elem.name === name)
                ) {
                    const link = this.buildLink(elem, source, doc);
                    if (link) links.push(link);
                }
            }
        }
        return links;
    }

    /** Enum declaration by name. */
    private lookupEnum(name: string, source: LeafCstNode): LocationLink[] {
        const links: LocationLink[] = [];
        for (const doc of this.docs.all) {
            const prog = doc.parseResult.value;
            if (!isProgram(prog)) continue;
            for (const elem of prog.elements) {
                if (isEnumDeclaration(elem) && elem.name === name) {
                    const link = this.buildLink(elem, source, doc);
                    if (link) links.push(link);
                }
            }
        }
        return links;
    }

    /** Specific enum variant by enum name + variant name. */
    private lookupVariant(
        enumName: string,
        variantName: string,
        source: LeafCstNode,
    ): LocationLink[] {
        const links: LocationLink[] = [];
        for (const doc of this.docs.all) {
            const prog = doc.parseResult.value;
            if (!isProgram(prog)) continue;
            for (const elem of prog.elements) {
                if (!isEnumDeclaration(elem) || elem.name !== enumName) continue;
                for (const member of elem.members) {
                    if (isEnumVariant(member) && member.name === variantName) {
                        const link = this.buildLink(member, source, doc);
                        if (link) links.push(link);
                    }
                }
            }
        }
        return links;
    }

    /**
     * Method by name, optionally filtered by namespace (type/enum name).
     * Searches StructMethod, ExtensionMethod, ExtensionProperty, EnumMethod.
     */
    private lookupMethod(
        name: string,
        namespace: string | undefined,
        source: LeafCstNode,
    ): LocationLink[] {
        const links: LocationLink[] = [];
        for (const doc of this.docs.all) {
            const prog = doc.parseResult.value;
            if (!isProgram(prog)) continue;
            for (const elem of prog.elements) {

                // Struct methods (defined inline in the type body)
                if (isTypeDeclaration(elem) && (namespace === undefined || elem.name === namespace)) {
                    if (isStructBody(elem.body)) {
                        for (const m of elem.body.members) {
                            if (isStructMethod(m) && m.name === name) {
                                const link = this.buildLink(m, source, doc);
                                if (link) links.push(link);
                            }
                        }
                    }
                }

                // Extension methods / properties
                if (
                    isExtensionDeclaration(elem) &&
                    (namespace === undefined || elem.typeName.ref?.name === namespace)
                ) {
                    for (const m of elem.methods) {
                        if (m.name === name) {
                            const link = this.buildLink(m, source, doc);
                            if (link) links.push(link);
                        }
                    }
                    for (const p of elem.properties) {
                        if (p.name === name) {
                            const link = this.buildLink(p, source, doc);
                            if (link) links.push(link);
                        }
                    }
                }

                // Enum methods
                if (isEnumDeclaration(elem) && (namespace === undefined || elem.name === namespace)) {
                    for (const member of elem.members) {
                        if (isEnumMethod(member) && member.name === name) {
                            const link = this.buildLink(member, source, doc);
                            if (link) links.push(link);
                        }
                    }
                }

                // Top-level functions that match (e.g. free-standing `fn name(…)`)
                if (isFunctionDeclaration(elem) && elem.name === name && namespace === undefined) {
                    const link = this.buildLink(elem, source, doc);
                    if (link) links.push(link);
                }
            }
        }
        return links;
    }

    // -----------------------------------------------------------------------
    // LocationLink builder
    // -----------------------------------------------------------------------

    private buildLink(
        target: AstNode,
        source: LeafCstNode,
        targetDoc: LangiumDocument,
    ): LocationLink | undefined {
        const nameCst = this.nameProvider.getNameNode(target);
        const selectionCst = nameCst ?? target.$cstNode;
        const containerCst = target.$cstNode;
        if (!selectionCst || !containerCst) return undefined;

        return LocationLink.create(
            targetDoc.textDocument.uri,
            containerCst.range,   // full declaration range (shown as peek)
            selectionCst.range,   // name token range (cursor jumps here)
            source.range,         // originating range (the token user clicked)
        );
    }
}
