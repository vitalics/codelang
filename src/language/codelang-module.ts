import type {
    DefaultSharedCoreModuleContext,
    LangiumCoreServices,
    LangiumSharedCoreServices,
    Module,
    PartialLangiumCoreServices
} from 'langium';
import { createDefaultCoreModule, createDefaultSharedCoreModule, inject } from 'langium';
import { CodeLangGeneratedModule, CodeLangGeneratedSharedModule, CodeLangLanguageMetaData } from './generated/module.js';
import { CodeLangValidator, registerValidationChecks } from './codelang-validator.js';

// ── Service types ────────────────────────────────────────────────────────────

export type CodeLangAddedServices = {
    validation: {
        CodeLangValidator: CodeLangValidator;
    };
};

export type CodeLangServices = LangiumCoreServices & CodeLangAddedServices;

export const CodeLangModule: Module<CodeLangServices, PartialLangiumCoreServices & CodeLangAddedServices> = {
    validation: {
        CodeLangValidator: (services) => new CodeLangValidator(services),
    },
    // Switch to production mode so Chevrotain skips runtime grammar validation.
    // The grammar is already validated at codegen time (`langium generate`).
    // In development mode, the LLStar lookahead strategy emits "Ambiguous
    // Alternatives Detected" warnings for the intentionally benign ambiguity in
    // `AtomCond`: both `'(' OrCond ')'` and `expr=Expression` can start with `(`
    // when the expression is a grouped form.  The first alternative always wins
    // and produces the correct parse, so the warning is noise.
    LanguageMetaData: () => ({ ...CodeLangLanguageMetaData, mode: 'production' as const }),
};

// ── Factory ──────────────────────────────────────────────────────────────────

export function createCodeLangServices(context: DefaultSharedCoreModuleContext): {
    shared: LangiumSharedCoreServices;
    CodeLang: CodeLangServices;
} {
    const shared = inject(
        createDefaultSharedCoreModule(context),
        CodeLangGeneratedSharedModule
    );
    const CodeLang = inject(
        createDefaultCoreModule({ shared }),
        CodeLangGeneratedModule,
        CodeLangModule
    );
    shared.ServiceRegistry.register(CodeLang);
    registerValidationChecks(CodeLang);
    return { shared, CodeLang };
}
