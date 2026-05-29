import { inject } from 'langium';
import {
    createDefaultModule,
    createDefaultSharedModule,
    type DefaultSharedModuleContext,
    type LangiumServices,
    type LangiumSharedServices,
} from 'langium/lsp';
import {
    CodeLangGeneratedModule,
    CodeLangGeneratedSharedModule,
} from './generated/module.js';
import { CodeLangModule } from './codelang-module.js';
import { registerValidationChecks } from './codelang-validator.js';
import { CodeLangDefinitionProvider } from './codelang-definition-provider.js';

/**
 * LSP-only overrides — these are merged on top of createDefaultModule's
 * built-in providers. Only add services that differ from the defaults.
 */
const CodeLangLSPModule = {
    lsp: {
        DefinitionProvider: (services: LangiumServices) =>
            new CodeLangDefinitionProvider(services),
    },
};

/**
 * Creates the full set of Langium services including all LSP providers
 * (completion, go-to-definition, find-references, hover, rename, …).
 *
 * Use this factory in the language-server entry point.
 * The CLI compiler uses `createCodeLangServices` from codelang-module.ts
 * which omits LSP services to keep the binary lean.
 */
export function createCodeLangLSPServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    CodeLang: LangiumServices;
} {
    const shared = inject(
        createDefaultSharedModule(context),
        CodeLangGeneratedSharedModule,
    );
    const CodeLang = inject(
        createDefaultModule({ shared }),
        CodeLangGeneratedModule,
        // CodeLangModule only provides core + validation services; the cast is
        // safe because createDefaultModule provides all missing LSP services.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        CodeLangModule as any,
        CodeLangLSPModule,
    );
    shared.ServiceRegistry.register(CodeLang);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerValidationChecks(CodeLang as any);
    return { shared, CodeLang };
}
