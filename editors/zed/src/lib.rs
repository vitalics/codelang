use zed_extension_api::{
    self as zed, serde_json, LanguageServerId, Result, Worktree,
    DebugAdapterBinary, DebugConfig, DebugRequest, DebugScenario, DebugTaskDefinition,
    LaunchRequest, StartDebuggingRequestArguments, StartDebuggingRequestArgumentsRequest,
};

// ── Candidate paths ───────────────────────────────────────────────────────────

/// Ordered list of directories where `codelang-dap` / `codelang-lsp` might live.
fn candidate_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        // pnpm global
        dirs.push(format!("{}/.local/share/pnpm", home));
        // npm global (Linux)
        dirs.push(format!("{}/.npm-global/bin", home));
        // nvm default
        dirs.push(format!("{}/.nvm/versions/node/default/bin", home));
    }

    // System / Homebrew
    dirs.push("/usr/local/bin".to_string());
    dirs.push("/opt/homebrew/bin".to_string());
    dirs.push("/usr/bin".to_string());

    dirs
}

fn find_binary(name: &str, worktree: &Worktree) -> Option<String> {
    // 1. Project-local node_modules
    if let Some(p) = worktree.which(name) {
        return Some(p);
    }
    // 2. Explicit candidate paths
    for dir in candidate_dirs() {
        let candidate = format!("{}/{}", dir, name);
        if std::path::Path::new(&candidate).exists() {
            return Some(candidate);
        }
    }
    None
}

// ── Debugger helpers ──────────────────────────────────────────────────────────

/// DAP adapter name declared in extension.toml
const ADAPTER_NAME: &str = "codelang-debug";

/// Find `node` on the system (needed to run the JS adapter script).
fn find_node(worktree: &Worktree) -> Option<String> {
    if let Some(p) = worktree.which("node") {
        return Some(p);
    }
    for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    None
}

// ── Extension struct ──────────────────────────────────────────────────────────

/// Zed extension entry point for CodeLang.
///
/// Provides:
///  - Language server command (codelang-lsp)
///  - Debug adapter (codelang-dap — compiles .code files, then proxies to lldb-dap/gdb)
struct CodeLangExtension;

impl zed::Extension for CodeLangExtension {
    fn new() -> Self {
        CodeLangExtension
    }

    // ── Language server ───────────────────────────────────────────────────────

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command> {
        let binary = find_binary("codelang-lsp", worktree)
            .ok_or_else(|| {
                "codelang-lsp not found. \
                 Install it with: npm install -g codelang  (or pnpm add -g codelang)"
                    .to_string()
            })?;

        Ok(zed::Command {
            command: binary,
            args: vec!["--stdio".to_string()],
            env: Default::default(),
        })
    }

    // ── Debug adapter (DAP) ───────────────────────────────────────────────────

    /// Returns the binary info for the CodeLang DAP proxy adapter.
    ///
    /// The adapter is a Node.js script (`codelang-dap`) that:
    ///  1. Compiles the .code source file with DWARF debug info (--debug flag)
    ///  2. Spawns lldb-dap or gdb --interpreter=dap
    ///  3. Proxies all DAP messages between Zed and the native debugger
    fn get_dap_binary(
        &mut self,
        adapter_name: String,
        config: DebugTaskDefinition,
        user_provided_debug_adapter_path: Option<String>,
        worktree: &Worktree,
    ) -> Result<DebugAdapterBinary> {
        if adapter_name != ADAPTER_NAME {
            return Err(format!("Unknown adapter: {}", adapter_name));
        }

        // Locate `node`
        let node = find_node(worktree)
            .ok_or_else(|| "node not found — install Node.js 18+".to_string())?;

        // Locate the DAP adapter script.
        // If the user has a project-local install, prefer that.
        let adapter_script = if let Some(path) = user_provided_debug_adapter_path {
            path
        } else {
            find_binary("codelang-dap", worktree)
                .map(|p| {
                    // `codelang-dap` is a shell wrapper; we need the actual .js
                    // Try resolving the script alongside it
                    let js = std::path::Path::new(&p)
                        .parent()
                        .and_then(|dir| {
                            // node_modules/.bin/../codelang/debugger/out/index.js
                            let candidate = dir
                                .join("..")
                                .join("codelang")
                                .join("debugger")
                                .join("out")
                                .join("index.js");
                            if candidate.exists() {
                                Some(candidate.to_string_lossy().to_string())
                            } else {
                                None
                            }
                        });
                    js.unwrap_or(p)
                })
                .ok_or_else(|| {
                    "codelang-dap not found. \
                     Install it with: npm install -g codelang  (or pnpm add -g codelang)"
                        .to_string()
                })?
        };

        Ok(DebugAdapterBinary {
            command: Some(node),
            arguments: vec![adapter_script],
            envs: Default::default(),
            cwd: None,
            connection: None,
            request_args: StartDebuggingRequestArguments {
                configuration: config.config,
                request: StartDebuggingRequestArgumentsRequest::Launch,
            },
        })
    }

    /// All CodeLang debug configurations use a "launch" request (we always
    /// compile and start the program fresh; attach is not supported yet).
    fn dap_request_kind(
        &mut self,
        _adapter_name: String,
        _config: serde_json::Value,
    ) -> Result<StartDebuggingRequestArgumentsRequest> {
        Ok(StartDebuggingRequestArgumentsRequest::Launch)
    }

    /// Convert a high-level DebugConfig (from Zed's "New Debug Session" UI)
    /// into a DebugScenario that references the codelang-debug adapter.
    fn dap_config_to_scenario(&mut self, config: DebugConfig) -> Result<DebugScenario> {
        let launch_config = match config.request {
            DebugRequest::Launch(LaunchRequest { program, args, cwd, .. }) => {
                serde_json::json!({
                    "sourceFile":  program,
                    "args":        args,
                    "cwd":         cwd,
                    "stopOnEntry": config.stop_on_entry.unwrap_or(false),
                })
            }
            DebugRequest::Attach(_) => {
                return Err("CodeLang debugger does not support attach mode".to_string());
            }
        };

        Ok(DebugScenario {
            label:          config.label,
            adapter:        ADAPTER_NAME.to_string(),
            build:          None,
            config:         launch_config.to_string(),
            tcp_connection: None,
        })
    }
}

zed::register_extension!(CodeLangExtension);
