grammar CodeLang

entry Program:
    elements+=TopLevelElement*;

TopLevelElement:
    BareImport | NamespaceImport | SwitchImport
    | FunctionDeclaration | TypeDeclaration | EnumDeclaration | ExternDeclaration | ProtocolDeclaration | ExtensionDeclaration
    | MacroDeclaration
    | TopLevelMacroCall
;

// ── Import forms ──────────────────────────────────────────────────────────────
//
// Two ways to bring an external module into scope:
//
//   1. Bare import — every exported name is injected directly into scope:
//
//        import "./greetings"
//        greet()                  // calls greet from greetings.code
//
//   2. Namespace import — exports are accessed through a named prefix:
//
//        const g = import "./greetings"
//        g.greet()                // same call, explicit namespace
//
// Module resolution (inspired by Rust + Node.js):
//   "./foo"       →  ./foo.code
//   "./foo"       →  ./foo/index.code   (directory fallback)
//   "./foo.code"  →  ./foo.code         (explicit extension)
//
// Only relative paths (./  or  ../) are supported in this release.

// import "./greetings"
BareImport:
    'import' source=STRING ';'
;

// const g = import "./greetings"
NamespaceImport:
    'const' name=ID '=' 'import' source=STRING ';'
;

// ── Conditional import (compile-time dispatch) ────────────────────────────────
//
// Selects one module to import based on a compile-time built-in value.
// The condition must be a qualified call: <namespace>.<method>()
// where the only supported namespace is `compile`.
//
// Built-in compile values:
//   compile.arch()     — CPU architecture: "arm64", "x64", "arm", …
//   compile.os()       — OS platform: "darwin", "linux", "win32", …
//   compile.platform() — combined: "darwin-arm64", "linux-x64", …
//
// Example:
//
//   const backend = switch_import! compile.arch() {
//       "arm64"  => "./backends/arm64.code",
//       "x86_64" => "./backends/x86_64.code",
//       else     => "./backends/generic.code",
//   }
//
// The selected module is bound to `backend` as a namespace, identical to:
//   const backend = import "./backends/arm64.code"

// const backend = switch_import! compile.arch() { "arm64" => "./arm.code", else => "./generic.code" }
SwitchImport:
    'const' name=ID '=' 'switch_import' '!'
    condObj=ID '.' condMethod=ID '(' ')'
    '{' arms+=SwitchImportArm* ('else' '=>' elsePath=STRING ','?)? '}' ';'?
;

SwitchImportArm:
    pattern=STRING '=>' path=STRING ','?
;

// ── Decorator ─────────────────────────────────────────────────────────────────
//
// A compile-time annotation that can be applied to types, functions, enum
// declarations, variable declarations, parameters, and struct fields.
//
// Syntax:
//   @derive(Displayable, Serialize)        ← identifier args (protocol names)
//   @doc("This is documentation")          ← string literal arg
//   @json(skip)                            ← single identifier arg
//   @json(skipIf = "self.isEmpty()")       ← named string arg
//   @log                                   ← no args
//
// Placement:
//   @derive(Displayable)   type Point { … }         type declaration
//   @log                   fn doWork(…) { … }       function declaration
//   @doc("info")           const a = "qwe"          variable declaration
//   @doc("param is cool")  param: int = 10          function parameter
//   @json(skip)            x: int                   struct field
//   @derive(Displayable)   enum Color { … }         enum declaration

Decorator:
    '@' name=ID ('(' (args+=DecoratorArg (',' args+=DecoratorArg)*)? ')')?
;

// A single argument inside a decorator invocation.
// Supports:
//   @derive(Displayable)              → identVal = "Displayable"
//   @doc("text")                      → strVal   = "text"
//   @version(42)                      → numVal   = 42
//   @json(skip)                       → identVal = "skip"
//   @json(skipIf = "self.isEmpty()")  → key = "skipIf", strVal = "…"
//   @json(priority = 1)               → key = "priority", numVal = 1
DecoratorArg:
    (key=ID '=')?
    ( strVal=STRING
    | numVal=NUMBER
    | identVal=ID
    )
;

// ── Type Declaration ─────────────────────────────────────────────────────────
//
//   type Int32   = intrinsic("i32");       ← maps directly to an LLVM primitive
//   type Number  = Float64;                ← alias for another declared type
//   type Box<T>  = T;                      ← generic alias
//
// These declarations are what the stdlib ships.  User code can read them.

TypeParam:
    name=ID ('extends' bound=TypeBound)? ('=' defaultType=TypeReference)?
;

// A bound on a type parameter.  Supports union bounds such as `Any | Any[]`
// to express "either a plain type or a tuple" — the canonical constraint for
// the Callable protocol's first type parameter.
//
// Grammar: TypeBound ::= TypeBoundAtom ( '|' TypeBoundAtom )*
//
// Examples
//   A extends Any          → single plain-type bound
//   A extends Any[]        → array/tuple bound
//   A extends Any | Any[]  → union: either a plain type or a tuple (Callable)
//
// Bounds are used for documentation/type-checking only; the IR generator does
// not enforce them at runtime.
TypeBound:
    first=TypeBoundAtom ('|' rest+=TypeBoundAtom)*
;

// A single atom in a type bound: an identifier optionally followed by `[]`.
TypeBoundAtom:
    name=ID (array?='[' ']')?
;

TypeDeclaration:
    decorators+=Decorator*
    (export?='export')? 'type' name=ID
    ('<' typeParams+=TypeParam (',' typeParams+=TypeParam)* '>')?
    ('extends' parentName=ID ('<' parentTypeArgs+=TypeReference (',' parentTypeArgs+=TypeReference)* '>')? )?
    (('=' body=TypeBody ';') | body=StructBody)
;

TypeBody:
    IntrinsicBody | AliasBody | StructBody
;

// Struct body: named fields and optional inline methods.
// Fields may be separated by whitespace or an optional trailing ',' — both styles work.
// Example:
//   type Point = {
//       x: int          // whitespace-separated
//       y: int = 10,    // comma after default value (optional but allowed)
//       fn sum(): int { return self.x + self.y; }
//   };
StructBody:
    '{' (members+=StructMember ','?)* '}'
;

StructMember:
    FieldDeclaration | StructMethod | CallableMethod
;

// Callable method — a method without the `fn` keyword, implicitly static (no `self`).
// Used in types extending protocol types like `Callable<A, R>`, `Displayable`, etc.
// The method name becomes the dispatch key; `MyType(args)` desugars to
// `@MyType_call(args)` in LLVM IR when the method is named `call`.
//
//   type MyType extends Callable<int, int> {
//     call(n: int): int { return n * 2; }
//   }
//
// Body statements still require semicolons.
CallableMethod:
    (export?='export')? (comptime?='const')? name=ID
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' returnType=TypeReference)?
    body=Block
;

FieldDeclaration:
    decorators+=Decorator*
    (readonly?='const')? (disposable?='using')? name=ID ':' type=TypeReference ('=' defaultValue=Expression)?
;

// FieldArrayInit is kept as a standalone rule for backward-compat
// (legacy `= [v0, v1, v2, ...]` array initializers are now parsed as ArrayLiteral
// via the Expression route above).
FieldArrayInit:
    '[' (values+=NUMBER (',' values+=NUMBER)*)? ']'
;

StructMethod:
    (export?='export')? (static?='static')? (comptime?='const')? 'fn' name=ID
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' returnType=TypeReference)?
    body=Block
;

// `intrinsic("llvm-type-string")` — the raw LLVM IR type to use at codegen.
IntrinsicBody:
    'intrinsic' '(' llvmType=STRING ')'
;

// An alias simply re-exports another named type.
AliasBody:
    alias=TypeReference
;

// ── Function Declaration ─────────────────────────────────────────────────────
//
//   export const fn pure(const x: Int32): Int32 { ... }  ← exported, compile-time
//   export fn runtime(x: Int32) { ... }                   ← exported, runtime
//   fn local() { ... }                                    ← module-private
//
// Optional type annotation after the name (before params) lets a function be
// bound to a named function-type alias.  Parameters without explicit types are
// inferred from the annotation's parameter list:
//
//   type F = fn(acc: int, val: int): int;
//   fn reduce: ReduceFn(arr: Int[], f: F, init: int) { ... }
//   fn compose: ComposeFn(f, g) { ... }   ← f, g types come from ComposeFn

FunctionDeclaration:
    decorators+=Decorator*
    (export?='export')? (comptime?='const')? 'fn' name=ID
    (':' typeAnnotation=TypeReference)?
    ('<' typeParams+=TypeParam (',' typeParams+=TypeParam)* '>')?
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' returnType=TypeReference)?
    body=Block
;

// ── Block ────────────────────────────────────────────────────────────────────

Block: '{'
    statements+=Statement*
'}';

// ── Macro block ───────────────────────────────────────────────────────────────
//
// Like Block but allows bare expressions without a trailing `;` (implicit
// return) and `$T extends Protocol { }` fragments inside emit{} bodies.
// Used exclusively by MacroDeclaration bodies and EmitStatement block arms.

MacroBlock: '{'
    elements+=MacroBlockElement*
'}';

MacroBlockElement:
    // $T extends Protocol { } — only when MACRO_VAR is followed by 'extends'
    MacroExtensionStatement
    // Regular statements (all end with ';' or are block statements)
    | Statement
    // Bare expression with no trailing ';' (implicit return value in macro body)
    | {infer MacroExprStatement} expr=Expression
;

// ── Statements ───────────────────────────────────────────────────────────────
//
// Inline statements end with ';'.
// Block statements (if) do NOT require a trailing ';'.

Statement:
    ( VariableDeclaration
    | UsingDeclaration
    | CompoundAssignStatement      // before AssignmentStatement — longer token (+=, -=, …)
    | AssignmentStatement
    | ChainedMemberCallStatement   // (self | ID).field.method(...) — must precede MemberCallStatement
    | MemberCallStatement
    | MacroCallStatement           // ID '!' '(' args ')' — before CallStatement (longer match when '!' present)
    | CallStatement
    | PrintStatement
    | PanicStatement
    | ReturnStatement
    | DeferStatement
    | BreakStatement
    | ContinueStatement
    | SuperCallStatement
    | EmitStatement                // emit $var or emit { … }
    ) ';'
    | IfStatement
    | WhileStatement
    | SwitchStatement              // switch subject { arm => { … } … }
    | MacroForStatement            // for $var in $var { } — before ForStatement (starts with $)
    | ForStatement
    | FunctionDeclaration          // nested fn declaration (no trailing ';')
    | MacroDeclaration             // nested macro declaration (no trailing ';')
;

// ── Variable declaration ─────────────────────────────────────────────────────
//
//   let x = "hello"            mutable,   type inferred
//   let x: String = "hello"    mutable,   type explicit
//   let x: String              mutable,   uninitialized
//   const x = "hello"          immutable, type inferred
//   const x: String = "hi"     immutable, type explicit

VariableDeclaration:
    decorators+=Decorator*
    ( mutable?='let' | 'const' ) name=ID
    (':' varType=TypeReference)?
    ('=' value=Expression)?
;

// ── Using declaration ─────────────────────────────────────────────────────────
//
// Declares a mutable resource binding that is automatically disposed when the
// enclosing function returns.  The type must implement the Disposable protocol
// (provide a `dispose()` method).  Equivalent to:
//
//   let <name>: <Type> = <value>;
//   defer <name>.dispose();
//
//   using b: Buffer = str.toBuffer();   ← b.dispose() is called on every exit path
//   using conn = openConnection();    ← type inferred from expression

UsingDeclaration:
    'using' name=ID (':' varType=TypeReference)? '=' value=Expression
;

// ── Defer statement ───────────────────────────────────────────────────────────
//
// Schedules a call to be executed when the enclosing function returns,
// regardless of which return path is taken.  Multiple defers run in LIFO order
// (last registered runs first), mirroring Go's defer semantics.
//
//   defer b.free();           ← member call on a variable
//   defer cleanup();          ← plain function call
//
// The target must be a call expression (CallExpression or MemberCallExpression).

DeferStatement:
    'defer' target=Expression
;

// ── Assignment ───────────────────────────────────────────────────────────────

AssignmentStatement:
    target=[NamedVar:ID] '=' value=Expression
;

// ── Member call statement (namespace import access) ───────────────────────────
//
//   const g = import "./greetings"
//   g.greet("Alice");               ← MemberCallStatement
//
// `namespace` is the name of a NamespaceImport binding.
// `member` is the name of an exported function in that module.

MemberCallStatement:
    (selfCall?='self' | namespace=ID) '.' member=ID '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// ── Chained member call statement ─────────────────────────────────────────────
//
// Handles two-level member access + call as a statement:
//
//   self.field.method(args);
//   obj.field.method(args);
//
// This is needed for dispatching protocol methods on struct fields, e.g.
//   self.value.toString()   inside a generic struct method body.

ChainedMemberCallStatement:
    (selfCall?='self' | namespace=ID) '.' field=ID '.' member=ID
    '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// ── Function call statement ───────────────────────────────────────────────────
//
//   greet("Alice");
//   log();

CallStatement:
    callee=ID ('<' typeArgs+=TypeReference (',' typeArgs+=TypeReference)* '>')? '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// ── Built-in statements ──────────────────────────────────────────────────────

PrintStatement:
    'print' '(' value=Expression ')'
;

// panic(msg) — terminates the process immediately with an error message printed
// to stderr.  Accepts any String expression or a string literal.
// Because it never returns, it acts as a block terminator: code after panic()
// in the same block is unreachable.
//
//   panic("index out of bounds");
//   panic(errorMessage);
PanicStatement:
    'panic' '(' value=Expression ')'
;

ReturnStatement:
    'return' value=Expression?
;

// ── Condition ─────────────────────────────────────────────────────────────────
//
//   a == 5                   comparison (leaf node)
//   a > 0 && b < 10          logical AND — short-circuits on false left side
//   x == 0 || y == 0         logical OR  — short-circuits on true left side
//   (a > 0 && b > 0) || c == 5   grouped with parentheses
//
//   Precedence (low → high):  ||  <  &&  <  atom
//
//   Leaf conditions are BoolExprCondition — a full Expression (which already
//   includes comparison operators via BinExprComp).  Compound conditions use
//   BinaryCondition for && / ||.
//
//   Used by IfExpression, IfStatement, WhileStatement, ForStatement.

Condition:
    OrCond
;

OrCond infers Condition:
    AndCond ({infer BinaryCondition.left=current} op='||' right=AndCond)*
;

AndCond infers Condition:
    AtomCond ({infer BinaryCondition.left=current} op='&&' right=AtomCond)*
;

AtomCond infers Condition:
    '(' OrCond ')'
    // Any expression — comparison operators are part of Expression via BinExprComp,
    // so `a == b`, `x < 5`, function calls returning bool, etc. all parse here.
    | {infer BoolExprCondition}
        expr=Expression
;

// ── If expression ─────────────────────────────────────────────────────────────
//
//   if a == 5 { 4 } else { 5 }
//   let x = if n > 0 { n } else { 0 };
//   return if flag == true { "yes" } else { "no" };
//   if (n == 0) { 1 } else { n }      ← C-style parens: AtomCond handles '(' OrCond ')'
//
// Both arms contain a single expression and yield a value.
// The `else` branch is mandatory (so the expression always has a type).
//
// Note: optional-paren wrappers ('(')? ... (')')? are intentionally absent.
// AtomCond already handles '(' OrCond ')' so C-style parens parse naturally and
// without Chevrotain AMBIGUOUS_ALTERNATIVES warnings.

IfExpression:
    'if' condition=Condition
    '{' thenExpr=Expression '}'
    'else' '{' elseExpr=Expression '}'
;

// ── If statement ──────────────────────────────────────────────────────────────
//
//   if a == 5 { print("yes"); }
//   if n > 0 { x = 1; } else { x = 0; }
//   if (n <= 1) { return n; }          ← C-style parens: AtomCond handles '(' OrCond ')'
//   if a == 1 { ... } else if a == 2 { ... } else { ... }   ← chained
//
// Arms are full statement blocks.
// The `else` branch is optional and may itself be an `IfStatement` (else-if).
//
// Note: optional-paren wrappers ('(')? ... (')')? are intentionally absent.
// See IfExpression note above.

IfStatement:
    'if' condition=Condition
    thenBlock=Block
    ('else' (elseIf=IfStatement | elseBlock=Block))?
;

// ── Break / Continue ─────────────────────────────────────────────────────────
//
//   break;      — exit the nearest enclosing loop immediately
//   continue;   — skip the rest of the loop body and go to the next iteration
//                 (for a `for` loop this runs the update step first)

BreakStatement:
    {infer BreakStatement} 'break'
;

ContinueStatement:
    {infer ContinueStatement} 'continue'
;

// ── While statement ───────────────────────────────────────────────────────────
//
//   while i <= n { i = i + 1; }
//   while (x > 0) { x = x - 1; }    ← C-style parens: AtomCond handles '(' OrCond ')'
//
// Loops until `condition` becomes false.
//
// Note: optional-paren wrappers ('(')? ... (')')? are intentionally absent.
// See IfExpression note above.

WhileStatement:
    'while' condition=Condition
    body=Block
;

// ── Switch statement ──────────────────────────────────────────────────────────
//
// Pattern-matching statement.  Like SwitchExpression but used as a statement —
// no result value is produced; each arm executes a Block for its side effects.
//
//   switch key {
//       "up"    => { selected = selected - 1; }
//       "down"  => { selected = selected + 1; }
//       "q"     => { running = false; }
//       else    => {}
//   }
//
// Patterns: string literals, integer literals, bool literals, EnumPattern, else.
// A trailing comma after each arm block is optional (but allowed for consistency).
// The else arm is a catch-all; if omitted and no pattern matches, execution
// continues after the switch block with no effect.

SwitchStatement:
    'switch' subject=Expression '{'
        arms+=SwitchStmtArm+
    '}'
;

// One arm of a switch statement.  The body is always a Block.
SwitchStmtArm:
    ( strPat=STRING
    | numPat=NUMBER
    | truePat?='true'
    | falsePat?='false'
    | enumPat=EnumPattern
    | else?='else'
    ) '=>' block=Block ','?
;

// ── For statement ─────────────────────────────────────────────────────────────
//
//   for (let i: int = 0; i < n; i++) { ... }
//   for (let i: int = len - 1; i >= 0; i--) { ... }
//   for (let i: int = 0; i < n; i = i + step) { ... }
//
// Desugars to a while loop:
//   init; while (condition) { body; update; }
//
// The update supports:
//   i++          increment by 1
//   i--          decrement by 1
//   i = expr     arbitrary reassignment

ForStatement:
    'for' '('
        init=VariableDeclaration ';'
        condition=Condition ';'
        update=ForUpdate
    ')'
    body=Block
;

// Update clause of a for loop.
// `target` is a plain ID resolved against varCtx at codegen time
// (no cross-reference — the init variable may not be in Langium scope yet).
ForUpdate:
    target=ID (increment?='++' | decrement?='--' | ('=' value=Expression))
;

// ── Compound assignment ───────────────────────────────────────────────────────
//
//   x += 1;          add and assign
//   x -= n;          subtract and assign
//   s += " world";   string concatenation and assign (calls concat())

CompoundAssignStatement:
    target=[NamedVar:ID] op=('+=' | '-=' | '*=' | '/=') value=Expression
;

// ── Expressions with binary precedence ───────────────────────────────────────
//
// Precedence (low → high):
//   |            (bitwise or)
//   ^            (bitwise xor)
//   &            (bitwise and)
//   << >>        (left / right shift)
//   + -          (additive)
//   * / %        (multiplicative)
//   atoms        (literals, calls, variables, grouped sub-expressions)
//
// Left-associative binary operators use Langium's {infer BinaryExpr.left=current}
// action to build a left-leaning AST without explicit left recursion.
//
// MemberCallExpression comes before CallExpression (longer prefix ID.ID(...)).
// IfExpression comes before CallExpression / VariableRef so `if` isn't treated
// as a function name.
// CallExpression comes before VariableRef so `ID '('` wins over bare `ID`.
//
// Note: `>>` uses maximal-munch tokenisation.  Nested generic close-brackets
// (e.g. Array<Array<int>>) should be written with a space (`> >`).

Expression:
    BinExprComp
;

// Comparison operators — lower precedence than bitwise, higher than &&/||.
// This level lets `x % 2 == 0` be a valid expression (not just a condition).
//   x % 2 == 0     →  BinaryExpr(x%2, ==, 0)  : i1
//   return a > b;  →  BinaryExpr(a, >, b)      : i1
BinExprComp infers Expression:
    BinExprBitOr ({infer BinaryExpr.left=current} op=('==' | '!=' | '<' | '>' | '<=' | '>=') right=BinExprBitOr)*
;

BinExprBitOr infers Expression:
    BinExprBitXor ({infer BinaryExpr.left=current} op='|' right=BinExprBitXor)*
;

BinExprBitXor infers Expression:
    BinExprBitAnd ({infer BinaryExpr.left=current} op='^' right=BinExprBitAnd)*
;

BinExprBitAnd infers Expression:
    BinExprShift ({infer BinaryExpr.left=current} op='&' right=BinExprShift)*
;

BinExprShift infers Expression:
    BinExprAdd ({infer BinaryExpr.left=current} op=('<<' | '>>') right=BinExprAdd)*
;

BinExprAdd infers Expression:
    BinExprMul ({infer BinaryExpr.left=current} op=('+' | '-') right=BinExprMul)*
;

BinExprMul infers Expression:
    UnaryExpr ({infer BinaryExpr.left=current} op=('*' | '/' | '%') right=UnaryExpr)*
;

// ── Unary expressions ─────────────────────────────────────────────────────────
//
//   -x       negate a numeric value   (sub 0, x  for integers; fneg for floats)
//   !x       logical NOT of a bool    (xor x, true)
//
// Unary minus works on any numeric type; unary NOT works on booleans.
// Both operators bind tighter than * / % (higher precedence than multiplicative).
//
// Examples:
//   abs(-7)          ← -7 is UnaryExpr { op: '-', operand: 7 }
//   let n = -x       ← negate variable
//   if !flag { … }   ← logical NOT in condition (via Condition rule)

UnaryExpr infers Expression:
      {infer UnaryExpr} op=('-' | '!') operand=ExprPostfix
    | ExprPostfix
;

// ── Postfix method-call chaining ─────────────────────────────────────────────
//
// Allows chaining a method call on the result of any expression:
//
//   arr.getSafe(i).unwrapOr(0)        ← Option<int> → int
//   result.ok().unwrapOr(defaultVal)  ← Result method then Option method
//
// Uses Langium's {infer X.receiver=current} left-recursion elimination idiom,
// identical to binary-operator levels (BinExprAdd, BinExprMul, etc.).
//
// Precedence: higher than unary (binds tighter than `-`/`!`).
// Each `.member(args)` suffix wraps the previous expression as the receiver.
//
//   arr.getSafe(i).unwrapOr(0)
//   → PostfixCallExpr {
//       receiver: MemberCallExpression { namespace: "arr", member: "getSafe", … },
//       member: "unwrapOr",
//       args: [0]
//     }

ExprPostfix infers Expression:
    ExprAtom
    ({infer PostfixCallExpr.receiver=current}
        '.' member=ID '(' (args+=Expression (',' args+=Expression)*)? ')'
    )*
;

ExprAtom infers Expression:
      '(' Expression ')'          // grouped sub-expression
    | TemplateLiteral
    | StringLiteral
    | NumberLiteral
    | BoolLiteral
    | IfExpression
    | SwitchExpression            // switch subject { arm, … }
    | ChainedMemberCallExpr       // (self | ID) '.' ID '.' ID '(' ... ')' — before MemberCallExpression/FieldAccess
    | MacroCallExpression         // ID '!' '(' args ')' — before CallExpression (unique due to '!')
    | MacroCallFieldAccess        // ID '(' args ')' '.' ID — before CallExpression (longer match)
    | MemberCallExpression        // (self | ID) '.' ID '(' ... ')' — before FieldAccess
    | FieldAccess                 // (self | ID) '.' ID              — no '(' after
    | SelfCallExpression          // 'self' '(' ... ')' — call self as a function value
    | SelfExpression              // bare 'self' — after MemberCallExpression/FieldAccess
    | SuperCallExpression         // 'super' '.' ID '(' ... ')' — parent-type method call
    | ArrayLiteral                 // [] or [e1, e2, …] — array literal; type inferred from context
    | LambdaExpression            // fn(params): RetType { body } — before CallExpression ('fn' is a keyword, no conflict)
    | EnumConstructor             // Name::Variant or Name::Variant(args) — before CallExpression/VariableRef
    | CallExpression              // ID '(' ... ')' — before StructLiteral/VariableRef
    | AnonymousStructLiteral      // '{' ... '}' — type inferred from annotation context — before StructLiteral
    | StructLiteral               // ID '{' ... '}' or Self '{' ... '}' — before VariableRef
    | MacroVarRef                 // $name — macro variable reference; before VariableRef
    | VariableRef
;

// ── Switch expression ─────────────────────────────────────────────────────────
//
// Pattern-matching expression that selects a value from a set of arms.
// Each arm maps a literal pattern to either a block or a direct expression.
//
//   let x = switch s {
//     "foo" => "got foo",           ← expression arm
//     "bar" => { return "got bar" } ← block arm (early function return)
//     else  => "other",             ← catch-all arm (required if not exhaustive)
//   }
//
// Supported patterns: string literals, integer literals, bool literals, else.
// Arms are separated by commas; a trailing comma is allowed.

SwitchExpression:
    'switch' subject=Expression '{'
        arms+=SwitchArm (',' arms+=SwitchArm)* ','?
    '}'
;

// One arm inside a switch expression.
// Exactly one of strPat / numPat / truePat / falsePat / enumPat / else is set.
// Body is either a block (statements, may contain return) or a bare expression.
SwitchArm:
    ( strPat=STRING
    | numPat=NUMBER
    | truePat?='true'
    | falsePat?='false'
    | enumPat=EnumPattern          // Name::Variant or Name::Variant(bindings)
    | else?='else'
    ) '=>' ( block=Block | expr=Expression )
;

// An enum pattern used inside a switch arm.
// Optional binding list destructures payload fields into local names.
// Use '_' as a wildcard to ignore a specific payload field.
//
//   Direction::North             ← unit variant, no bindings
//   Shape::Circle(r)             ← bind radius to r
//   Shape::Rect(w, h)            ← bind both fields
//   Result::Err(_)               ← payload present but discarded
EnumPattern:
    enumName=ID '::' variant=ID
    ('(' bindings+=EnumBinding (',' bindings+=EnumBinding)* ')')?
;

// A single binding slot inside an EnumPattern.
EnumBinding:
    wildcard?='_' | name=ID
;

SelfExpression infers SelfExpression: {infer SelfExpression} 'self';

// Invoke self as a callable fat pointer: `self(arg1, arg2)`.
// Used in extension methods on function-value types, e.g.:
//   Function<A, R> extends Callable<A, R> {
//     fn call(arg: A): R { return self(arg); }
//   }
SelfCallExpression:
    {infer SelfCallExpression} 'self' '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// Super call expression — dispatches to the parent type's static or instance method.
// Used as a value:  const parent = super.new(args)
//
//   super.new(size)          ← parent's static factory
//   super.clone()            ← parent's instance method
SuperCallExpression:
    'super' '.' member=ID '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// Super call statement — like SuperCallExpression but discards the return value.
//   super.init();
//   super.dispose();
SuperCallStatement:
    'super' '.' member=ID '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// Field access expression — access a named field on a local variable or self.
//   self.myField    →  selfReceiver = true, field = "myField"
//   point.x        →  receiver = "point",  field = "x"
FieldAccess infers FieldAccess:
    {infer FieldAccess}
    (selfReceiver?='self' | receiver=ID) '.' field=ID
;

// Template string  $"hello {expr} world"
// Holes can contain simple expressions: variables, integers, arithmetic.
// Escape sequences (\n, \t, \\, \") work as in regular strings.
// Multi-line template strings are allowed.
TemplateLiteral: value=TEMPLATE_STRING;

StringLiteral: value=STRING;
NumberLiteral: value=NUMBER;
BoolLiteral:   value?='true' | 'false';

// Reference to any named variable or parameter in scope
VariableRef: ref=[NamedVar:ID];

// Member call expression — qualified call used as a value:
//   const g = import "./utils"
//   let result = g.compute(x)    ← namespace call
//   let s2 = self.id()           ← self call (inside extension or struct method)
//   let v = point.sum()          ← variable receiver call
MemberCallExpression:
    (selfCall?='self' | namespace=ID ('<' nsTypeArgs+=TypeReference (',' nsTypeArgs+=TypeReference)* '>')?) '.' member=ID '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// Chained member call expression — two-level access + call used as a value:
//   self.field.method(args)
//   obj.field.method(args)
//
// Covers the common pattern of calling a protocol method on a struct field,
// e.g. inside a generic struct:  self.value.toString()
ChainedMemberCallExpr:
    (selfCall?='self' | namespace=ID) '.' field=ID '.' member=ID
    '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// Function call expression — the result is used as a value
//
//   compute()
//   add(x, 1)
//   wrap(inner(val))    ← nested calls
//   cast<string>(anyVal) ← explicit type argument (generic intrinsics)
//   typeInfo<MyColor>()  ← explicit type argument (reflection)
CallExpression:
    callee=ID ('<' typeArgs+=TypeReference (',' typeArgs+=TypeReference)* '>')? '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// ── Struct literal ─────────────────────────────────────────────────────────────
//
// Creates a new instance of a struct type by providing values for all its fields.
//
//   Self { data: IntArray.new() }     ← inside a static struct method
//   Point { x: 3, y: 4 }             ← explicit type name
//
// Field list may be empty for zero-field structs: Vec { }
// `Self` is the conventional name for the current type (resolved at codegen).

StructLiteral:
    (typeName=ID | selfLiteral?='Self') '{' (fields+=StructFieldInit (',' fields+=StructFieldInit)* ','?)? '}'
;

// Anonymous struct literal — type name is omitted; the struct type is inferred from
// the surrounding variable declaration's type annotation.
//
//   let p: Point = {};          ← all fields use their defaults
//   let p: Point = { x: 5 };   ← x=5, y uses its default
//
// The `anon` flag distinguishes this from a plain Block at the grammar level:
// `{}` in expression position is unambiguous since Blocks never appear as atoms.
AnonymousStructLiteral:
    {infer AnonymousStructLiteral} '{' (fields+=StructFieldInit (',' fields+=StructFieldInit)* ','?)? '}'
;

// name: value pair inside a struct literal, or a spread, or a shorthand.
//
//   field: value     ← named field (explicit value)
//   ...parent        ← spread: copy matching fields from `parent`
//   field,           ← shorthand: equivalent to `field: field`
//                      (the variable named `field` fills the field of the same name)
//
// Alternatives are tried in order: spread → named → shorthand.
// The parser disambiguates named vs shorthand by looking one token ahead after
// the identifier: `:` means named, `,` or `}` means shorthand.
StructFieldInit:
    ('...' source=ID) | (name=ID ':' value=Expression) | (shorthand=ID)
;

// ── Array literal ─────────────────────────────────────────────────────────────
//
// `[]`         — empty array; element type inferred from context.
// `[1, 2, 3]`  — array with initial elements; type inferred from context.
//
// The compiler emits a `TypeArray.new()` call followed by one push per element.
// Element type is inferred from the expected type in the surrounding context.

ArrayLiteral: {infer ArrayLiteral} '[' (elements+=Expression (',' elements+=Expression)*)? ']';

// ── Lambda expression ─────────────────────────────────────────────────────────
//
// An anonymous function expression (closure) that can be passed as a value.
//
//   fn(x: int): int { return x * 2; }           ← non-capturing lambda
//   fn(x: int): int { return x + n; }           ← closure (captures n)
//   map(nums, fn(x: int): int { return x + 1; }) ← inline lambda argument
//
// If the enclosing function is declared `const`, a lambda that captures outer
// variables is a compile-time error (purity violation).

LambdaExpression:
    'fn' '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' returnType=TypeReference)?
    body=Block
;

// ── Parameters ───────────────────────────────────────────────────────────────
//
//   fn foo(x: Int32)               mutable parameter, explicit type
//   fn foo(const x: Int32)         immutable parameter (assignment → compile error)
//   fn foo(n: int = 100)           parameter with default value
//   fn foo(n = 100)                default value, type inferred (i32)
//   fn foo(x, y, max = 2000)       positional + trailing default
//   fn foo(s: string | Code)       union type — accepts any listed alternative;
//                                  the primary type (left of first |) determines the
//                                  LLVM representation; all alternatives must share it

Parameter: decorators+=Decorator* (immutable?='const')? name=ID (':' type=TypeReference ('|' unionRest+=TypeReference)*)? ('=' defaultValue=Expression)?;

// ── Union of named bindable elements (for cross-references) ──────────────────
//
// FunctionDeclaration is included so that a bare function name can be used
// as a first-class value in an expression (function reference):
//   const op: fn(int): int = double;   ← VariableRef resolves to FunctionDeclaration

// EnumBinding is included so that pattern binding names (e.g. the `r` in
// `Shape::Circle(r) => r * r`) are treated as variable declarations in scope.
type NamedVar = VariableDeclaration | Parameter | UsingDeclaration | FunctionDeclaration | EnumBinding;

// ── Named-type union ──────────────────────────────────────────────────────────
//
// Covers both struct/alias TypeDeclarations and enum EnumDeclarations so that:
//   - TypeReference can resolve enum names in type positions (let d: Direction)
//   - ExtensionDeclaration can target enum types (Color extends Displayable { … })

type NamedType = TypeDeclaration | EnumDeclaration;

// ── Type references ──────────────────────────────────────────────────────────
//
// `void` is the only built-in primitive (no-value return).
// Every other type is resolved via a cross-reference to a NamedType (struct or enum).
// Generic type references carry optional type arguments: Array<int>, Box<string>, etc.
//
// Function types use the `fn(T1, T2): R` syntax:
//   fn(int): int              ← single unnamed param
//   fn(acc: int, val: int): int  ← named params (documentation only)
//   fn(): bool                ← no params
//   fn(int): fn(int): int     ← returns a function (right-associative return type)

// ── TypeReference ─────────────────────────────────────────────────────────────
//
// `const` qualifier on a named type:
//   const int     — fixed-width integer; never auto-promoted to a wider type
//   const Number  — stays as a fixed-size value (i64); no BigInt upscaling
//   const T       — type parameter pinned to its concrete width
//
// The qualifier is only meaningful on named types (`ref` alternative).
// `const void`, `const fn(...)`, `const [T]` are parse errors by design.
//
// `const` on a *field* (`const x: int`) is a field-level modifier already
// handled by FieldDeclaration.readonly — distinct from the type qualifier.
TypeReference:
    ( primitive='void' )
    // `Self` keyword in type position — resolves to the enclosing struct/protocol type.
    // Equivalent to writing the type name explicitly; avoids the cross-reference
    // resolution issue that `ref=[NamedType:ID]` would trigger for a keyword.
    //   static fn new(name: string): Self { return Self { name }; }
    | ( selfType?='Self' )
    // Array type shorthand: ElemType[] or ElemType[N] or ElemType[N; v0, v1, ...]
    // ElemType[] → dynamic array (sugar for the corresponding XxxArray type)
    // ElemType[N] → fixed-size N-element array ([N x llvmTy] embedded in struct)
    // ElemType[N; v0,...] → value-typed fixed array (initializer must match)
    | ( elemRef=[NamedType:ID] '[' (arraySize=NUMBER (';' typeValues+=NUMBER (',' typeValues+=NUMBER)*)?)? ']' )
    // Tuple type: [T1, T2, ...] — used as type argument for variadic Function<A, R>
    | ( tupleType?='[' (tupleElems+=TypeReference (',' tupleElems+=TypeReference)*)? ']' )
    // Function type: fn(T1, T2): R  or  fn(...A): R  (spread of a tuple type param)
    | ( fnType?='fn' '('
            ( '...' fnSpread=TypeReference
            | (fnParams+=FnTypeParam (',' fnParams+=FnTypeParam)*)? )
        ')' (':' fnReturnType=TypeReference)? )
    // typeof($expr) — macro return-type that mirrors the argument's type
    | ( typeofKw?='typeof' '(' typeofArg=MACRO_VAR ')' )
    // typeOf(varName) — infer the type from a runtime variable in the current scope
    // Usage: const b: typeOf(a) = expr   (b gets the same LLVM type as a)
    | ( typeOfKw?='typeOf' '(' typeOfArgId=ID ')' )
    // Named type — optionally const-qualified to pin the representation
    | ( (constQualified?='const')? ref=[NamedType:ID] ('<' typeArgs+=TypeReference (',' typeArgs+=TypeReference)* '>')? )
;

// A parameter entry in a function type signature.
// The name is optional and serves only as documentation.
//   fn(int): int              ← unnamed
//   fn(acc: int, b: int): int ← named
FnTypeParam:
    (name=ID ':')? type=TypeReference
;

// ── Extern function declaration ───────────────────────────────────────────────
//
// Declares an externally-defined C function so it can be called from CodeLang.
// The compiler emits a `declare` in LLVM IR; the linker resolves it from the
// C runtime.
//
//   extern fn strlen(const s: string): int;
//   export extern fn length(const s: string): int;

ExternDeclaration:
    (export?='export')? 'extern' 'fn' name=ID
    ('<' typeParams+=TypeParam (',' typeParams+=TypeParam)* '>')?
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' returnType=TypeReference)?
    ';'
;

// ── Enum Declaration ──────────────────────────────────────────────────────────
//
// Declares a sum type: either a simple discriminant enum (all unit variants)
// or a tagged union (at least one variant carries a payload).
//
// Three forms of behaviour attachment — all combinable:
//
//   enum Color { Red, Green, Blue,                  ← variants only
//     fn toHex(): string { … }                       ← inline own method
//   }
//
//   enum Color extends Displayable { … }             ← inline protocol conformance
//
//   Color extends Displayable { … }                  ← separate extension block (same as structs)
//
// Variant syntax:
//   North,                        ← unit variant (auto-tag)
//   East = 10,                    ← unit variant with explicit i32 tag
//   Circle(float),                ← one payload field
//   Rect(float, float),           ← two payload fields
//
// Recursive variants (e.g. Add(Expr, Expr)) are heap-boxed automatically.

EnumDeclaration:
    decorators+=Decorator*
    (export?='export')? 'enum' name=ID
    ('<' typeParams+=TypeParam (',' typeParams+=TypeParam)* '>')?
    ('extends' protocol=ID ('<' protocolTypeArgs+=TypeReference (',' protocolTypeArgs+=TypeReference)* '>')?)?
    '{'
        members+=(EnumVariant | EnumMethod)*
    '}'
;

// A single variant inside an enum body.
// Optional explicit integer tag overrides the auto-incrementing counter.
// Optional payload list gives this variant associated data fields.
EnumVariant:
    name=ID ('=' tag=NUMBER)? ('(' payloads+=TypeReference (',' payloads+=TypeReference)* ')')? ','
;

// A method defined inline inside an enum body.
// Behaves identically to an ExtensionMethod — self refers to the enum value.
EnumMethod:
    (export?='export')? (static?='static')? (comptime?='const')? 'fn' name=ID
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' returnType=TypeReference)?
    body=Block
;

// ── Enum constructor expression ───────────────────────────────────────────────
//
// Produces an enum value in expression position.
//   Direction::North                  ← unit variant
//   Shape::Circle(5.0)                ← variant with one argument
//   Expr::Add(Expr::Num(1), Expr::Num(2))  ← nested construction

EnumConstructor:
    enumName=ID '::' variant=ID
    ('(' args+=Expression (',' args+=Expression)* ','? ')')?
;

// ── Protocol Declaration ──────────────────────────────────────────────────────
//
// Declares an interface contract that ExtensionDeclarations can conform to.
//
// Three forms:
//
//   protocol Stringify {                  ← pure interface
//     fn toString(): string;
//   }
//
//   protocol Error extends Displayable {  ← inherits another protocol's contract
//     const name: string,                 ← required field
//     stacktrace: Option<Stacktrace>,     ← required field
//     static fn new(name: string) { … }  ← default static factory
//     fn toString() { … }                ← default instance method
//   }
//
// Field declarations in a protocol require that implementing types declare
// those fields.  Method bodies are default implementations injected into any
// conforming type that does not provide its own override.

ProtocolDeclaration:
    (export?='export')? 'protocol' name=ID
    ('<' typeParams+=TypeParam (',' typeParams+=TypeParam)* '>')?
    ('extends' parents+=ID (',' parents+=ID)*)?
    '{'
        (fields+=ProtocolField | signatures+=MethodSignature)*
    '}'
;

// A field declaration inside a protocol body.
// Requires that implementing types declare a field with this name and type.
//
//   const name: string,       ← read-only field requirement
//   stacktrace: Option<Trace> ← mutable field requirement
ProtocolField:
    decorators+=Decorator*
    (readonly?='const')? name=ID ':' type=TypeReference ','?
;

// A method signature inside a protocol declaration.
// The body is optional: when present it serves as the default implementation
// used by types that conform to the protocol but do not override the method.
//
//   protocol Displayable {
//     fn toString(): string { return "[Displayable]: default"; }   ← default
//     fn describe(): string;                                        ← abstract
//   }
//
// `static` marks a factory/class method — no implicit `self` parameter.
// `const` marks a compile-time-only method.
MethodSignature:
    (comptime?='const')? (static?='static')? 'fn' name=ID
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' returnType=TypeReference)?
    (body=Block | ';')
;

// ── Extension Declaration ─────────────────────────────────────────────────────
//
// Adds methods to an existing type, optionally conforming to a protocol.
// The protocol may carry type arguments that bind the type's own type params
// to the protocol's type params.
//
//   Boolean extends ToString {
//     fn toString(): string { ... }
//   }
//
//   Function<A, R> extends Callable<A, R> {
//     fn call(arg: A): R { return self(arg); }
//   }
//
//   Boolean extends {
//     fn toNumber(): int { ... }
//   }
//
// Inside method bodies, `self` refers to the receiver value.

ExtensionDeclaration:
    typeName=[NamedType:ID]
    ('<' typeParams+=TypeParam (',' typeParams+=TypeParam)* '>')?
    'extends' (protocol=ID ('<' protocolTypeArgs+=TypeReference (',' protocolTypeArgs+=TypeReference)* '>')?)? '{'
        (methods+=ExtensionMethod | properties+=ExtensionProperty)*
    '}'
;

ExtensionMethod:
    (export?='export')? (static?='static')? (comptime?='const')? 'fn' name=ID
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' returnType=TypeReference)?
    body=Block
;

// Static property inside an extension block — no function call syntax needed.
// Access as TypeName.PropertyName (no parentheses).
//
//   Number extends {
//       export static const Infinity: Number = number_infinity();
//   }
//   const inf: Number = Number.Infinity;
//
// The optional `const` keyword marks the property as read-only (a compile-time
// constant alias for the initializer expression).  Omitting it is also valid but
// `const` is preferred for values that never change.
ExtensionProperty:
    (export?='export') 'static' (const?='const')? name=ID ':' type=TypeReference '=' value=Expression ';'
;

// ── Macro declarations ────────────────────────────────────────────────────────
//
// Two forms:
//   macro assert!($cond: Expr, $msg: Literal = "…") { … }
//   const macro size_of!($T: Type): const int { … }
//
// Macro bodies use MacroBlock (more permissive than Block: allows bare
// expressions without ';' for implicit return, and special emit{} fragments).

// Macro names may collide with reserved keywords.
// 'panic' is reserved by PanicStatement; 'switch_import' by SwitchImportDeclaration.
// All other macro names are plain identifiers and need no special handling.
MacroIdent returns string:
    ID | 'panic' | 'switch_import'
;

MacroDeclaration:
    (export?='export')? (constMacro?='const')? 'macro' name=MacroIdent '!'
    '(' (params+=MacroParam (',' params+=MacroParam)*)? ')'
    (':' returnType=MacroReturnType)?
    body=MacroBlock
;

// A single parameter in a macro declaration.
//   $cond: Expr
//   $msg: Literal = "default"
//   ...$parts: Expr             ← variadic
//   $cond: const bool           ← compile-time evaluated parameter
MacroParam:
    (varargs?='...')? varName=MACRO_VAR ':' (constPrefix?='const')? metaType=ID
    ('=' defaultVal=Expression)?
;

// Return type of a macro.  Either a regular type (optionally `const`-qualified)
// or `typeof($arg)` (parsed as a TypeReference) to mirror the argument's type.
// MacroReturnType wraps a TypeReference.
// The `const` qualifier (e.g. `: const int`) is handled inside TypeReference itself
// via `constQualified?='const'` — no separate constReturn flag needed here.
MacroReturnType:
    typeRef=TypeReference
;

// Top-level macro call — e.g. `static_assert!(size_of!(int) >= 4, "msg");`
// placed at program scope, not inside a function body.
TopLevelMacroCall:
    callee=ID '!' '(' (args+=Expression (',' args+=Expression)*)? ')' ';'
;

// ── Macro call expression / statement ─────────────────────────────────────────
//
//   assert!(x > 0)          ← in expression position
//   assert!(x > 0);         ← as a statement

MacroCallExpression:
    callee=ID '!' '(' (args+=Expression (',' args+=Expression)*)? ')'
;

MacroCallStatement:
    callee=ID '!' '(' (args+=Expression (',' args+=Expression)*)? ')'
;

// ── Macro variable reference ──────────────────────────────────────────────────
//
//   $cond   $msg   $T   $expr   $part   $n

MacroVarRef:
    name=MACRO_VAR
;

// ── Macro-specific statements ─────────────────────────────────────────────────
//
//   for $part in $parts { … }     ← iterates over variadic macro args
//   emit $body;                    ← inserts macro var's captured code at call site
//   emit { … };                    ← inserts code fragment at call site

MacroForStatement:
    'for' varName=MACRO_VAR 'in' collection=MACRO_VAR body=Block
;

EmitStatement:
    'emit' (macroVarTarget=MACRO_VAR | block=MacroBlock)
;

// `$T extends Displayable { … }` — inside emit{} fragments, the type being
// extended is a macro variable rather than a statically-resolved name.
MacroExtensionStatement:
    typeName=MACRO_VAR 'extends' protocol=ID
    ('<' protocolTypeArgs+=TypeReference (',' protocolTypeArgs+=TypeReference)* '>')?
    '{' methods+=ExtensionMethod* '}'
;

// ── Call followed by field access ─────────────────────────────────────────────
//
//   reflect($T).name    ← function call result accessed as a field
//
// Placed before CallExpression in ExprAtom so the longer match wins.

MacroCallFieldAccess:
    callee=ID '(' (args+=Expression (',' args+=Expression)*)? ')' '.' field=ID
;

// ── Terminals ────────────────────────────────────────────────────────────────

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]+)?/;
// Macro variable terminal — must come before TEMPLATE_STRING because both
// start with '$'.  $name binds a macro parameter; $"…" is a template string.
terminal MACRO_VAR returns string: /\$[_a-zA-Z][\w_]*/;
// Template string terminal — must be listed before STRING so the lexer
// matches $"..." as TEMPLATE_STRING rather than as '$' + STRING.
// The pattern allows:
//   [^"\\{]     — any char that is not " \ {
//   \\[\s\S]    — any escape sequence (including \n, \t, \\ across lines)
//   {[^}]*}     — an interpolation hole: { followed by non-} chars then }
terminal TEMPLATE_STRING: /\$"([^"\\{]|\\[\s\S]|{[^}]*})*"/;
terminal STRING: /"(\\.|[^"\\])*"/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal HASH_COMMENT: /#[^\n\r]*/;
