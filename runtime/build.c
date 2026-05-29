/*
 * runtime/build.c
 *
 * CodeLang build-system runtime.
 *
 * This file is linked into the binary produced by compiling build.code.
 * It defines the Build / Executable / RunStep / Step C structs, implements
 * every `extern fn` declared in stdlib/build.code, and provides int main()
 * which:
 *   1. Parses CLI arguments (step name, --optimize, --prefix, --list).
 *   2. Calls the user's build(Build *b) function (compiled from build.code).
 *   3. Executes the requested step (or the default "install" step).
 *
 * Environment variables consumed at runtime:
 *   CODELANG_BIN   – absolute path to codelang.js       (required)
 *   CODELANG_NODE  – path to the node executable        (default: "node")
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#  include <process.h>
#  define POPEN  _popen
#  define PCLOSE _pclose
#else
#  include <unistd.h>
#  include <sys/wait.h>
#endif

/* ── Utility ──────────────────────────────────────────────────────────────── */

static char *xstrdup(const char *s) {
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *r = (char *)malloc(n);
    if (!r) { perror("malloc"); exit(1); }
    memcpy(r, s, n);
    return r;
}

/* ── Step ─────────────────────────────────────────────────────────────────── */

#define MAX_DEPS 32

typedef struct Step {
    char        *name;
    char        *desc;
    void       (*execute)(void *ctx);
    void        *ctx;
    struct Step *deps[MAX_DEPS];
    int          dep_count;
    int          done;   /* guards against double-execution */
} Step;

static Step *step_alloc(const char *name, const char *desc,
                        void (*execute)(void *), void *ctx) {
    Step *s = (Step *)calloc(1, sizeof(Step));
    if (!s) { perror("calloc"); exit(1); }
    s->name    = xstrdup(name);
    s->desc    = xstrdup(desc ? desc : "");
    s->execute = execute;
    s->ctx     = ctx;
    return s;
}

/* ── Executable ───────────────────────────────────────────────────────────── */

typedef struct Executable {
    char *name;
    char *source;
    char *destination;  /* NULL → use Build.prefix */
    int   optimize;     /* 0=Debug 1=ReleaseSafe 2=ReleaseFast 3=ReleaseSmall */
    Step *build_step;   /* synthetic compile step */
} Executable;

/* ── RunStep ──────────────────────────────────────────────────────────────── */

#define MAX_RUN_ARGS 64

typedef struct RunStep {
    Executable *exe;
    char       *extra_args[MAX_RUN_ARGS];
    int         arg_count;
    Step       *step;
} RunStep;

/* ── Build ────────────────────────────────────────────────────────────────── */

#define MAX_EXES  64
#define MAX_STEPS 128

typedef struct Build {
    Executable *exes[MAX_EXES];
    int         exe_count;
    Step       *steps[MAX_STEPS];
    int         step_count;
    int         optimize;       /* default OptimizeMode tag */
    char       *prefix;         /* install prefix (default: "build") */
    Step       *install_step;
} Build;

/* ── Forward declarations ─────────────────────────────────────────────────── */

void step_depends_on(Step *s, Step *dep);

/* ── subprocess helpers ───────────────────────────────────────────────────── */

#ifdef _WIN32
static int run_argv(const char **argv) {
    /* Build a quoted command string for system() on Windows */
    char cmd[4096] = {0};
    for (int i = 0; argv[i]; i++) {
        if (i > 0) strncat(cmd, " ", sizeof(cmd) - strlen(cmd) - 1);
        strncat(cmd, "\"", sizeof(cmd) - strlen(cmd) - 1);
        strncat(cmd, argv[i], sizeof(cmd) - strlen(cmd) - 1);
        strncat(cmd, "\"", sizeof(cmd) - strlen(cmd) - 1);
    }
    return system(cmd);
}
#else
static int run_argv(const char **argv) {
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return -1; }
    if (pid == 0) {
        execvp(argv[0], (char *const *)argv);
        perror("execvp");
        _exit(127);
    }
    int status;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 127;
}
#endif

/* ── Step actions ─────────────────────────────────────────────────────────── */

static void compile_exe_action(void *ctx) {
    Executable  *exe  = (Executable *)ctx;

    const char *node = getenv("CODELANG_NODE");
    if (!node || node[0] == '\0') node = "node";

    const char *bin = getenv("CODELANG_BIN");
    if (!bin || bin[0] == '\0') {
        fprintf(stderr,
            "codelang build: CODELANG_BIN is not set.\n"
            "  This variable must point to the codelang.js script.\n");
        exit(1);
    }

    const char *dest = exe->destination ? exe->destination : "./build/bin";

    /* Ensure destination directory exists */
#ifdef _WIN32
    { char mkdir_cmd[2048]; snprintf(mkdir_cmd, sizeof(mkdir_cmd), "mkdir \"%s\" 2>NUL", dest); system(mkdir_cmd); }
#else
    { char mkdir_cmd[2048]; snprintf(mkdir_cmd, sizeof(mkdir_cmd), "mkdir -p '%s'", dest); system(mkdir_cmd); }
#endif

    printf("  compile  %s  →  %s/%s\n", exe->source, dest, exe->name);
    fflush(stdout);

    if (exe->optimize == 0) {
        /* Debug build: add -g */
        const char *argv[] = { node, bin, "compile", exe->source,
                                "--debug", "--destination", dest, NULL };
        int code = run_argv(argv);
        if (code != 0) { fprintf(stderr, "build: compile failed (exit %d)\n", code); exit(code); }
    } else {
        const char *argv[] = { node, bin, "compile", exe->source,
                                "--destination", dest, NULL };
        int code = run_argv(argv);
        if (code != 0) { fprintf(stderr, "build: compile failed (exit %d)\n", code); exit(code); }
    }
}

static void run_exe_action(void *ctx) {
    RunStep    *rs   = (RunStep *)ctx;
    Executable *exe  = rs->exe;
    const char *dest = exe->destination ? exe->destination : "./build/bin";

    /* Build the exe path */
    char exe_path[4096];
#ifdef _WIN32
    snprintf(exe_path, sizeof(exe_path), "%s\\%s.exe", dest, exe->name);
#else
    snprintf(exe_path, sizeof(exe_path), "%s/%s", dest, exe->name);
#endif

    printf("  run      %s\n", exe->name);
    fflush(stdout);

    /* argv = [exe_path, extra_args..., NULL] */
    int     argc = 1 + rs->arg_count + 1;
    const char **argv = (const char **)malloc((size_t)argc * sizeof(char *));
    if (!argv) { perror("malloc"); exit(1); }
    argv[0] = exe_path;
    for (int i = 0; i < rs->arg_count; i++) argv[1 + i] = rs->extra_args[i];
    argv[1 + rs->arg_count] = NULL;

    int code = run_argv(argv);
    free(argv);
    if (code != 0) {
        fprintf(stderr, "build: run failed (exit %d)\n", code);
        exit(code);
    }
}

/* ── Step execution (DFS topological order) ───────────────────────────────── */

static void step_execute(Step *s) {
    if (s->done) return;
    s->done = 1;
    for (int i = 0; i < s->dep_count; i++) step_execute(s->deps[i]);
    if (s->execute) s->execute(s->ctx);
}

/* ── Extern functions called from CodeLang IR ─────────────────────────────── */

Executable *build_exe(Build *b, const char *name, const char *source) {
    Executable *exe = (Executable *)calloc(1, sizeof(Executable));
    if (!exe) { perror("calloc"); exit(1); }
    exe->name      = xstrdup(name);
    exe->source    = xstrdup(source);
    exe->optimize  = b->optimize;
    exe->build_step = step_alloc(name, name, compile_exe_action, exe);
    if (b->exe_count < MAX_EXES) b->exes[b->exe_count++] = exe;
    return exe;
}

void build_install(Build *b, Executable *exe) {
    if (!exe->destination) {
        /* Append /bin to prefix, e.g. "build" → "build/bin" */
        size_t n = strlen(b->prefix) + 5;
        exe->destination = (char *)malloc(n);
        if (!exe->destination) { perror("malloc"); exit(1); }
        snprintf(exe->destination, n, "%s/bin", b->prefix);
    }
    /* install step depends on this exe being compiled */
    step_depends_on(b->install_step, exe->build_step);
}

RunStep *build_run(Build *b, Executable *exe) {
    (void)b;
    RunStep *rs = (RunStep *)calloc(1, sizeof(RunStep));
    if (!rs) { perror("calloc"); exit(1); }
    rs->exe  = exe;
    rs->step = step_alloc("run", "run", run_exe_action, rs);
    /* run step depends on compile step */
    step_depends_on(rs->step, exe->build_step);
    return rs;
}

Step *build_step_new(Build *b, const char *name, const char *desc) {
    Step *s = step_alloc(name, desc, NULL, NULL);
    if (b->step_count < MAX_STEPS) b->steps[b->step_count++] = s;
    return s;
}

int build_optimize_tag(Build *b) {
    return b->optimize;
}

const char *build_prefix(Build *b) {
    return b->prefix;
}

void exe_set_optimize(Executable *exe, int tag) {
    exe->optimize = tag;
}

void exe_set_destination(Executable *exe, const char *dir) {
    free(exe->destination);
    exe->destination = xstrdup(dir);
}

Step *runstep_as_step(RunStep *rs) {
    return rs->step;
}

void runstep_add_arg(RunStep *rs, const char *arg) {
    if (rs->arg_count < MAX_RUN_ARGS)
        rs->extra_args[rs->arg_count++] = xstrdup(arg);
}

void step_depends_on(Step *s, Step *dep) {
    if (s->dep_count < MAX_DEPS) s->deps[s->dep_count++] = dep;
}

/* ── User's build() — defined in build.code, compiled to LLVM IR ─────────── */

extern void build(Build *b);

/* ── main ─────────────────────────────────────────────────────────────────── */

int main(int argc, char **argv) {
    /* ── Parse CLI args ───────────────────────────────────────────────────── */
    const char *step_name = NULL;
    int         do_list   = 0;
    int         optimize  = 0;          /* default: Debug */
    const char *prefix    = "build";

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--list") == 0) {
            do_list = 1;
        } else if (strcmp(argv[i], "--optimize") == 0 && i + 1 < argc) {
            const char *m = argv[++i];
            if      (strcmp(m, "Debug")        == 0) optimize = 0;
            else if (strcmp(m, "ReleaseSafe")  == 0) optimize = 1;
            else if (strcmp(m, "ReleaseFast")  == 0) optimize = 2;
            else if (strcmp(m, "ReleaseSmall") == 0) optimize = 3;
            else {
                fprintf(stderr, "build: unknown optimize mode '%s'\n"
                        "  valid: Debug | ReleaseSafe | ReleaseFast | ReleaseSmall\n", m);
                return 1;
            }
        } else if (strcmp(argv[i], "--prefix") == 0 && i + 1 < argc) {
            prefix = argv[++i];
        } else if (argv[i][0] != '-') {
            step_name = argv[i];
        }
    }

    /* ── Initialise Build ─────────────────────────────────────────────────── */
    Build b;
    memset(&b, 0, sizeof(b));
    b.optimize     = optimize;
    b.prefix       = xstrdup(prefix);
    b.install_step = step_alloc("install", "Build and install all artifacts", NULL, NULL);
    b.steps[b.step_count++] = b.install_step;

    /* ── Call the user's build() function ────────────────────────────────── */
    build(&b);

    /* ── --list ───────────────────────────────────────────────────────────── */
    if (do_list) {
        printf("Available steps:\n");
        for (int i = 0; i < b.step_count; i++) {
            Step *s = b.steps[i];
            printf("  %-20s  %s\n", s->name, s->desc);
        }
        return 0;
    }

    /* ── Find and execute the requested step ─────────────────────────────── */
    Step *target = NULL;
    if (!step_name) {
        target = b.install_step;
    } else {
        for (int i = 0; i < b.step_count; i++) {
            if (strcmp(b.steps[i]->name, step_name) == 0) {
                target = b.steps[i];
                break;
            }
        }
        if (!target) {
            fprintf(stderr, "build: no step named '%s'\n"
                            "  Run with --list to see available steps.\n", step_name);
            return 1;
        }
    }

    step_execute(target);
    printf("  done.\n");
    return 0;
}
