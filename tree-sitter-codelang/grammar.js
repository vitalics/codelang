/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: 'codelang',

  word: $ => $.identifier,

  extras: $ => [
    /\s/,
    $.comment,
  ],

  conflicts: $ => [
    // `identifier {` is ambiguous: struct_literal start vs variable_ref before a block.
    [$.struct_literal, $.variable_ref],
    // `ID ::` starts both enum_constructor and enum_pattern (same prefix).
    [$.enum_constructor, $.enum_pattern],
  ],

  rules: {
    // ── Top level ─────────────────────────────────────────────────────────────
    program: $ => repeat($._top_level),

    _top_level: $ => choice(
      $.bare_import,
      $.namespace_import,
      $.switch_import_declaration,         // const io = switch_import! … { … };
      $.type_declaration,
      $.enum_declaration,
      $.extern_declaration,
      $.protocol_declaration,
      $.extension_declaration,
      $.function_declaration,
      $.macro_declaration,
      seq($.macro_call_expression, ';'),
    ),

    // ── Import forms ──────────────────────────────────────────────────────────
    //
    //   import "./greetings";           ← bare: all exports injected into scope
    //   const g = import "./greetings"; ← namespace: access via g.greet()
    //   const io = switch_import! compile.arch() {
    //       "arm64"  => "stdlib/io",    ← conditional import: comptime dispatch
    //       "x86_64" => "stdlib/io",
    //       else     => "stdlib/io",
    //   };

    bare_import: $ => seq(
      $.import_keyword,
      field('source', $.string_literal),
      ';',
    ),

    namespace_import: $ => seq(
      $.const_keyword,
      field('name', $.identifier),
      '=',
      $.import_keyword,
      field('source', $.string_literal),
      ';',
    ),

    // switch_import! subject { "pattern" => "path", … , else => "path" }
    // Used as an expression value:
    //   const io = switch_import! compile.arch() { … };
    switch_import_expression: $ => seq(
      $.switch_import_keyword,
      '!',
      field('subject', $._expression),
      '{',
      seq(
        $.switch_import_arm,
        repeat(seq(',', $.switch_import_arm)),
        optional(','),
      ),
      '}',
    ),

    switch_import_keyword: _ => 'switch_import',

    // "arm64" => "stdlib/io"  /  else => "stdlib/io"
    switch_import_arm: $ => seq(
      field('pattern', choice(
        $.string_literal,
        alias('else', $.else_pattern),
      )),
      '=>',
      field('source', $.string_literal),
    ),

    // const io = switch_import! compile.arch() { … };
    // Top-level form: mirrors namespace_import but with switch_import_expression.
    switch_import_declaration: $ => seq(
      $.const_keyword,
      field('name', $.identifier),
      '=',
      $.switch_import_expression,
      ';',
    ),

    import_keyword: _ => 'import',

    // ── Decorator ─────────────────────────────────────────────────────────────
    //   @derive(Displayable, Serialize)
    //   @deprecated
    //
    // A compile-time annotation applied before a type or function declaration.
    // @name                               ← no args
    // @derive(Displayable, Serialize)      ← identifier args
    // @doc("text")                         ← string arg
    // @json(skip)                          ← identifier arg
    // @json(skipIf = "self.isEmpty()")     ← named string arg
    // @version(priority = 1)              ← named number arg
    decorator: $ => seq(
      '@',
      field('name', $.identifier),
      optional(seq(
        '(',
        optional(seq(
          field('arg', $.decorator_arg),
          repeat(seq(',', field('arg', $.decorator_arg))),
        )),
        ')',
      )),
    ),

    // A single argument inside a decorator's parentheses.
    decorator_arg: $ => seq(
      optional(seq(field('key', $.identifier), '=')),
      field('value', choice(
        $.string_literal,
        $.number_literal,
        $.identifier,
      )),
    ),

    // ── Type declaration ──────────────────────────────────────────────────────
    //   type Int32              = intrinsic("i32");     ← intrinsic
    //   type Number             = Float64;              ← alias
    //   export type Boolean     = intrinsic("i1");      ← exported intrinsic
    //   export type Function<A, R> = fn(A): R;          ← generic function type
    //   type IntStack { data: IntArray  fn push() { … } }  ← struct (no = ;)
    //   type Point = { x: int  y: int };                ← struct with = ;
    //   Function<A,R> extends Callable<A,R> { … }       ← struct with parent
    type_declaration: $ => seq(
      repeat($.decorator),
      optional($.export_keyword),
      $.type_keyword,
      field('name', $.identifier),
      optional(field('type_params', $.type_params)),
      optional(field('parent', $.type_extends_clause)),
      choice(
        seq('=', field('body', $._type_body), ';'),
        field('body', $.struct_body),
      ),
    ),

    // extends Callable<A, R>  /  extends Base
    type_extends_clause: $ => seq(
      'extends',
      field('parent', $.identifier),
      optional(seq(
        '<',
        field('type_arg', $.type_reference),
        repeat(seq(',', field('type_arg', $.type_reference))),
        '>',
      )),
    ),

    // <A, R>  /  <T extends Comparable>
    type_params: $ => seq(
      '<',
      field('param', $.type_param),
      repeat(seq(',', field('param', $.type_param))),
      '>',
    ),

    type_param: $ => seq(
      field('name', $.identifier),
      optional(seq('extends', field('bound', $.type_bound))),
    ),

    // A bound on a type parameter — may be a union of atoms.
    //   Any            ← plain-type bound
    //   Any[]          ← array/tuple bound
    //   Any | Any[]    ← union bound: "either a plain type or a tuple"
    type_bound: $ => seq(
      field('atom', $.type_bound_atom),
      repeat(seq('|', field('atom', $.type_bound_atom))),
    ),

    // Single atom: identifier optionally followed by `[]`
    type_bound_atom: $ => seq(
      field('name', $.identifier),
      optional(seq('[', ']')),
    ),

    _type_body: $ => choice($.intrinsic_body, $.alias_body, $.struct_body),

    intrinsic_body: $ => seq(
      $.intrinsic_keyword,
      '(',
      field('llvm_type', $.string_literal),
      ')',
    ),

    // Alias body accepts any type reference so that:
    //   type Number  = Float64;           ← plain name
    //   type F       = fn(int): int;      ← function type
    //   type IntArr  = int[];             ← array shorthand
    //   type Box<T>  = Array<T>;          ← generic alias
    alias_body: $ => field('alias', $.type_reference),

    // ── Struct body ───────────────────────────────────────────────────────────
    //   { data: IntArray  fn push(item: int) { … }  static fn new(): Self { … } }
    struct_body: $ => seq(
      '{',
      repeat($.struct_member),
      '}',
    ),

    struct_member: $ => choice(
      $.field_declaration,
      $.struct_method,
      $.callable_method,
    ),

    // @json(skip)
    // data: IntArray              ← plain mutable field
    // const x: int                ← readonly after construction  (const before name)
    // z: const int                ← const type modifier          (const before type)
    // const k: const int = 1     ← readonly + const type + default value
    field_declaration: $ => seq(
      repeat($.decorator),
      optional($.const_keyword),                              // readonly modifier
      field('name', $.identifier),
      ':',
      optional($.const_keyword),                              // const-type modifier
      field('type', $.type_reference),
      optional(seq('=', field('default', $._expression))),   // default value
    ),

    // export? static? const? fn name(params): ReturnType body
    struct_method: $ => seq(
      optional($.export_keyword),
      optional($.static_keyword),
      optional($.const_keyword),
      $.fn_keyword,
      field('name', $.identifier),
      '(',
      optional($.parameter_list),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
      field('body', $.block),
    ),

    // Callable method — method without `fn`, implicitly static (no `self`).
    // Used inside types that extend Callable<A, R>:
    //   type MyType extends Callable<int, int> {
    //     call(value: int): int { return value * 2; }
    //   }
    callable_method: $ => seq(
      optional($.export_keyword),
      optional($.const_keyword),
      field('name', $.identifier),
      '(',
      optional($.parameter_list),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
      field('body', $.block),
    ),

    type_keyword:      _ => 'type',
    intrinsic_keyword: _ => 'intrinsic',

    // ── Extern declaration ────────────────────────────────────────────────────
    //   extern fn strlen(const s: String): Int32;
    //   export extern fn length(const s: String): Int32;
    //
    // Declares an externally-defined C function (no body).
    extern_declaration: $ => seq(
      optional($.export_keyword),
      $.extern_keyword,
      $.fn_keyword,
      field('name', $.identifier),
      '(',
      optional($.parameter_list),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
      ';',
    ),

    extern_keyword: _ => 'extern',

    // ── Protocol declaration ──────────────────────────────────────────────────
    //   export protocol ToString { fn toString(): string; }
    //   export protocol Error extends Displayable {
    //       const name: string,          ← abstract field (protocol_field)
    //       stacktrace: Option<T>,       ← abstract field
    //       static fn new(…): Self { … } ← default / static method
    //   }
    protocol_declaration: $ => seq(
      optional($.export_keyword),
      $.protocol_keyword,
      field('name', $.identifier),
      optional(seq($.extends_keyword, field('extends_protocol', $.identifier))),
      '{',
      repeat(choice($.protocol_field, $.method_signature)),
      '}',
    ),

    // Abstract field requirement inside a protocol body — terminated with ','.
    //   const name: string,
    //   stacktrace: Option<Stacktrace>,
    protocol_field: $ => seq(
      optional($.const_keyword),                              // readonly modifier
      field('name', $.identifier),
      ':',
      optional($.const_keyword),                              // const-type modifier
      field('type', $.type_reference),
      ',',
    ),

    // Abstract:  fn name(params): Type;
    // Default:   fn name(params): Type { body }
    // Static:    static fn new(…): Self { … }
    method_signature: $ => seq(
      optional($.export_keyword),
      optional($.static_keyword),
      optional($.const_keyword),
      $.fn_keyword,
      field('name', $.identifier),
      '(',
      optional($.parameter_list),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
      choice(';', field('default_body', $.block)),
    ),

    protocol_keyword: _ => 'protocol',

    // ── Extension declaration ─────────────────────────────────────────────────
    //   Boolean extends ToString { export fn toString(): string { … } }
    //   Function<A, R> extends Callable<A, R> { … }            ← with type params
    //   Function<A extends Any[] | Any, R> extends Callable<A, R> { … }
    extension_declaration: $ => seq(
      field('type_name', $.identifier),
      optional(field('type_params', $.type_params)),
      $.extends_keyword,
      optional(seq(
        field('protocol', $.identifier),
        optional(field('protocol_type_args', $.type_params)),
      )),
      '{',
      repeat(choice($.extension_method, $.static_property)),
      '}',
    ),

    extends_keyword: _ => 'extends',

    // ── Enum declaration ──────────────────────────────────────────────────────
    //   enum Direction { North, South, East = 10, West = 11, }
    //   enum Shape { Circle(float), Rect(float, float), fn area(): float { … } }
    //   enum Color extends Displayable { Red, Green, Blue, export fn toString() { … } }
    //   enum Option<T> { Some(T), None, }
    enum_declaration: $ => seq(
      repeat($.decorator),
      optional($.export_keyword),
      $.enum_keyword,
      field('name', $.identifier),
      optional(field('type_params', $.type_params)),
      optional(seq(
        $.extends_keyword,
        field('protocol', $.identifier),
        optional(seq(
          '<',
          field('protocol_type_arg', $.type_reference),
          repeat(seq(',', field('protocol_type_arg', $.type_reference))),
          '>',
        )),
      )),
      '{',
      repeat(choice($.enum_variant, $.enum_method)),
      '}',
    ),

    enum_keyword: _ => 'enum',

    // North,  /  East = 10,  /  Circle(float),  /  Rect(float, float),
    enum_variant: $ => seq(
      field('name', $.identifier),
      optional(seq('=', field('tag', $.number_literal))),
      optional(seq(
        '(',
        field('payload', $.type_reference),
        repeat(seq(',', field('payload', $.type_reference))),
        ')',
      )),
      ',',
    ),

    // export? static? const? fn name(params): RetType { body }
    enum_method: $ => seq(
      optional($.export_keyword),
      optional($.static_keyword),
      optional($.const_keyword),
      $.fn_keyword,
      field('name', $.identifier),
      '(',
      optional($.parameter_list),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
      field('body', $.block),
    ),

    extension_method: $ => seq(
      optional($.export_keyword),
      optional($.static_keyword),
      optional($.const_keyword),
      $.fn_keyword,
      field('name', $.identifier),
      '(',
      optional($.parameter_list),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
      field('body', $.block),
    ),

    // export static const Infinity: Number = number_infinity();
    static_property: $ => seq(
      $.export_keyword,
      $.static_keyword,
      optional($.const_keyword),
      field('name', $.identifier),
      ':',
      field('type', $.type_reference),
      '=',
      field('value', $._expression),
      ';',
    ),

    static_keyword: _ => 'static',

    // ── Function declaration ──────────────────────────────────────────────────
    //   export const fn pure(const x: Int32): Int32 { … }
    //   export fn runtime(x: String) { … }
    //   fn local() { … }
    function_declaration: $ => seq(
      repeat($.decorator),
      optional($.export_keyword),
      optional($.static_keyword),
      optional($.const_keyword),
      $.fn_keyword,
      field('name', $.identifier),
      optional(field('type_params', $.type_params)),
      '(',
      optional($.parameter_list),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
      field('body', $.block),
    ),

    export_keyword: _ => 'export',
    const_keyword:  _ => 'const',
    fn_keyword:     _ => 'fn',

    // ── Macro declarations ────────────────────────────────────────────────────
    //   macro assert!($cond: Expr, $msg: Literal = "assertion failed") { … }
    //   const macro stringify!($expr: Expr): string { … }
    //   const macro size_of!($T: Type): const int { … }
    //   const macro unroll!($n: const int, $body: Block) { … }
    //   macro log!($level: Literal, ...$parts: Expr) { … }
    macro_declaration: $ => seq(
      optional($.const_keyword),
      $.macro_keyword,
      field('name', $.identifier),
      '!',
      '(',
      optional(seq(
        $.macro_param,
        repeat(seq(',', $.macro_param)),
      )),
      ')',
      optional(seq(':', optional($.const_keyword), field('return_type', $.type_reference))),
      field('body', $.block),
    ),

    macro_keyword: _ => 'macro',

    // $cond: Expr  /  $msg: Literal = "…"  /  ...$parts: Expr  /  $n: const int
    macro_param: $ => seq(
      optional('...'),
      field('name', $.macro_param_name),
      ':',
      optional($.const_keyword),
      field('type', $.identifier),
      optional(seq('=', field('default', $._expression))),
    ),

    // $cond  $expr  $T  $parts — sigil-prefixed macro parameter reference
    macro_param_name: _ => token(seq('$', /[_a-zA-Z][\w_]*/)),

    // assert!(x > 0)  /  dbg!(p.sum())  /  size_of!(int)
    // Used as both expression (const s = dbg!(…)) and statement (assert!(…);)
    macro_call_expression: $ => seq(
      field('name', $.identifier),
      '!',
      '(',
      optional(seq($._expression, repeat(seq(',', $._expression)))),
      ')',
    ),

    // $"text {expr} more"  — template / interpolated string literal
    template_string: _ => token(seq(
      '$',
      '"',
      repeat(choice(
        /[^"\\{]/,          // ordinary character
        /\\./,              // escape sequence  \n  \"  \\  …
        seq('{', /[^}]*/, '}'),  // interpolation hole  {expr}
      )),
      '"',
    )),

    // ── Parameters ────────────────────────────────────────────────────────────
    parameter_list: $ => seq(
      $.parameter,
      repeat(seq(',', $.parameter)),
    ),

    parameter: $ => seq(
      repeat($.decorator),
      optional($.const_keyword),
      field('name', $.identifier),
      ':',
      field('type', $.type_reference),
    ),

    // ── Type references ───────────────────────────────────────────────────────
    //   void
    //   int[]            ← dynamic array shorthand
    //   int[8]           ← fixed-size array
    //   int[8; 0, 1, 2]  ← fixed array with initializer values
    //   [int, string]    ← tuple type (used as type arg for variadic Function<A, R>)
    //   Array<int>        ← generic type
    //   fn(int): int      ← function type
    //   fn(...A): R       ← variadic function type (spread of a tuple type param)
    //   IntArray          ← plain type name
    type_reference: $ => choice(
      $.void_type,
      $.array_type,
      $.tuple_type,
      $.generic_type,
      $.fn_type,
      $.type_name,
    ),

    // [int, string]  /  [A, B, C]  /  []
    // Used as type arguments: Function<[int, string], bool>
    tuple_type: $ => seq(
      '[',
      optional(seq(
        $.type_reference,
        repeat(seq(',', $.type_reference)),
      )),
      ']',
    ),

    // fn(int): int     /  fn(A, B): C   /  fn(): void
    // fn(...A): R      ← variadic: spread a tuple type param across all args
    fn_type: $ => seq(
      $.fn_keyword,
      '(',
      choice(
        seq('...', field('spread', $.type_reference)),  // fn(...A): R
        optional(seq(
          $.fn_type_param,
          repeat(seq(',', $.fn_type_param)),
        )),
      ),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
    ),

    // A parameter entry in a function type signature.
    //   Unnamed: fn(int): int           → just a type_reference
    //   Named:   fn(acc: int): int      → identifier ':' type_reference (docs only)
    //
    // LR(1) disambiguation: if the token after the first identifier is ':', it is
    // the parameter name; otherwise it is the start of an unnamed type_reference.
    fn_type_param: $ => choice(
      seq(field('name', $.identifier), ':', field('type', $.type_reference)),
      field('type', $.type_reference),
    ),

    // int[]  /  int[N]  /  int[N; v0, v1, ...]
    array_type: $ => seq(
      field('element', $.identifier),
      '[',
      optional(seq(
        field('size', $.number_literal),
        optional(seq(
          ';',
          field('init', $.number_literal),
          repeat(seq(',', field('init', $.number_literal))),
        )),
      )),
      ']',
    ),

    // Array<int>  /  Box<string, int>
    generic_type: $ => seq(
      field('name', $.identifier),
      '<',
      field('type_arg', $.type_reference),
      repeat(seq(',', field('type_arg', $.type_reference))),
      '>',
    ),

    void_type:  _ => 'void',
    type_name:  $ => $.identifier,

    // ── Block ─────────────────────────────────────────────────────────────────
    block: $ => seq('{', repeat($._statement), '}'),

    // ── Statements ────────────────────────────────────────────────────────────
    //
    // Inline statements end with ';'.
    // if_statement / while_statement do NOT take a trailing ';'.
    _statement: $ => choice(
      seq(
        choice(
          $.variable_declaration,
          $.using_declaration,
          $.compound_assign_statement,   // x += expr  — before assignment (longer token)
          $.assignment_statement,
          $.chained_member_call_statement,
          $.member_call_statement,
          $.call_statement,
          $.macro_call_expression,       // assert!(…); — before call_statement (has '!')
          $.print_statement,
          $.panic_statement,
          $.defer_statement,
          $.return_statement,
          $.break_statement,
          $.continue_statement,
        ),
        ';',
      ),
      $.if_statement,
      $.while_statement,
      $.for_statement,
      $.switch_expression,               // switch subject { arms }  — standalone statement, no ';'
      $.macro_declaration,               // nested: const macro __loop!(…) { … }
    ),

    // @doc("info") const x = "hi"  /  let x: String
    variable_declaration: $ => seq(
      repeat($.decorator),
      choice($.let_keyword, $.const_keyword),
      field('name', $.identifier),
      optional(seq(':', field('type', $.type_reference))),
      optional(seq('=', field('value', $._expression))),
    ),

    let_keyword: _ => 'let',

    // using b: Buffer = str.toBuffer();   ← type explicit
    // using conn = openConnection();    ← type inferred
    using_declaration: $ => seq(
      $.using_keyword,
      field('name', $.identifier),
      optional(seq(':', field('type', $.type_reference))),
      '=',
      field('value', $._expression),
    ),

    using_keyword: _ => 'using',

    // x = expr
    assignment_statement: $ => seq(
      field('target', $.identifier),
      '=',
      field('value', $._expression),
    ),

    // self.push(item)  /  self.data.push(item)  /  self.a.b.c(args)
    // (self receiver + one-or-more .id steps; last step is the method)
    chained_member_call_statement: $ => seq(
      $.self_expression,
      repeat1(seq('.', field('step', $.identifier))),
      '(',
      optional(seq($._expression, repeat(seq(',', $._expression)))),
      ')',
    ),

    // g.greet("Alice");
    member_call_statement: $ => seq(
      field('namespace', $.identifier),
      '.',
      field('member', $.identifier),
      '(',
      optional(seq($._expression, repeat(seq(',', $._expression)))),
      ')',
    ),

    // greet("Alice");
    call_statement: $ => seq(
      field('callee', $.identifier),
      '(',
      optional(seq($._expression, repeat(seq(',', $._expression)))),
      ')',
    ),

    print_statement: $ => seq(
      $.print_keyword,
      '(',
      field('value', $._expression),
      ')',
    ),

    print_keyword: _ => 'print',

    // panic("msg") — terminate immediately with error
    panic_statement: $ => seq(
      $.panic_keyword,
      '(',
      field('value', $._expression),
      ')',
    ),
    panic_keyword: _ => 'panic',

    // defer expr;  (call executed on function exit)
    defer_statement: $ => seq(
      $.defer_keyword,
      field('target', $._expression),
    ),
    defer_keyword: _ => 'defer',

    // x += expr  /  x -= expr  /  x *= expr  /  x /= expr
    compound_assign_statement: $ => seq(
      field('target', $.identifier),
      field('op', choice('+=', '-=', '*=', '/=')),
      field('value', $._expression),
    ),

    return_statement: $ => seq('return', optional($._expression)),

    break_statement:    $ => $.break_keyword,
    continue_statement: $ => $.continue_keyword,

    break_keyword:    _ => 'break',
    continue_keyword: _ => 'continue',

    // ── If statement ──────────────────────────────────────────────────────────
    //   if n > 0 { print("yes"); }
    //   if (n <= 1) { return n; } else { return 0; }
    if_statement: $ => seq(
      'if',
      optional('('),
      field('condition', $.condition),
      optional(')'),
      field('then_block', $.block),
      optional(seq('else', field('else_block', $.block))),
    ),

    // ── For statement ─────────────────────────────────────────────────────────
    //   for (let i = 0; i < n; i++) { … }
    //   for (let i: Int32 = 0; i < n; i = i + 1) { … }
    for_statement: $ => seq(
      $.for_keyword,
      '(',
      field('init', $.variable_declaration),
      ';',
      field('condition', $.condition),
      ';',
      field('update', $.for_update),
      ')',
      field('body', $.block),
    ),

    // i++  /  i--  /  i = expr
    for_update: $ => seq(
      field('target', $.identifier),
      choice(
        '++',
        '--',
        seq('=', field('value', $._expression)),
      ),
    ),

    for_keyword: _ => 'for',

    // ── While statement ───────────────────────────────────────────────────────
    //   while i <= n { i = i + 1; }
    //   while (x > 0) { x = x - 1; }
    while_statement: $ => seq(
      $.while_keyword,
      optional('('),
      field('condition', $.condition),
      optional(')'),
      field('body', $.block),
    ),

    while_keyword: _ => 'while',

    // ── Condition ─────────────────────────────────────────────────────────────
    //   a == 5               — simple comparison
    //   a > 0 && b < 10      — logical AND  (higher precedence than ||)
    //   x == 0 || y == 0     — logical OR   (lower precedence)
    //   ctx.isActive         — bare boolean expression (property access / variable)
    //   isValid              — bare boolean variable
    //
    // Precedence (low → high):  bare expr  <  ||  <  &&  <  comparison
    condition: $ => choice(
      // OR — lowest precedence (1)
      prec.left(1, seq(
        field('left',  $.condition),
        field('op',    '||'),
        field('right', $.condition),
      )),
      // AND — middle precedence (2)
      prec.left(2, seq(
        field('left',  $.condition),
        field('op',    '&&'),
        field('right', $.condition),
      )),
      // Comparison — higher precedence (3); leaf nodes of a compound condition
      prec.left(3, seq(
        field('left',  $._expression),
        field('op',    choice('==', '!=', '<', '>', '<=', '>=')),
        field('right', $._expression),
      )),
      // Bare boolean expression — lowest priority (prec -1 loses to comparison
      // shift on '==','!=',… so `a == b` still takes the comparison path)
      prec(-1, $._expression),
    ),

    // ── Expressions ───────────────────────────────────────────────────────────
    //
    // Precedence (low → high):
    //   + -          additive
    //   * / %        multiplicative
    //   atoms        literals, calls, if-expr, grouped sub-expressions
    //
    // member_call_expression before call_expression (longer prefix ID.ID > ID).
    // call_expression before variable_ref (ID '(' > bare ID).

    _expression: $ => choice(
      $.binary_expression,
      $.grouped_expression,
      $.string_literal,
      $.template_string,              // $"text {expr} more"
      $.number_literal,
      $.bool_literal,
      $.switch_import_expression,     // switch_import! expr { … }  — comptime import dispatch
      $.fn_expression,                // fn(x: int): int { return x; }  — lambda / closure
      $.if_expression,
      $.switch_expression,            // switch subject { arms }
      $.struct_literal,               // TypeName { field: val, … }  — before call/ref
      $.enum_constructor,             // Name::Variant or Name::Variant(args) — before call/ref
      $.macro_call_expression,        // assert!(…) — before call_expression (has '!')
      $.chained_member_call_expression, // self.a.b(args)  — before member_call_expression
      $.member_call_expression,
      $.member_access_expression,     // ctx.isActive — property access without ()
      $.call_expression,
      $.empty_array_literal,     // []
      $.self_expression,
      $.macro_param_name,             // $cond $expr — used as values inside macro bodies
      $.variable_ref,
    ),

    binary_expression: $ => choice(
      prec.left(1, seq(
        field('left', $._expression),
        field('op', choice('+', '-')),
        field('right', $._expression),
      )),
      prec.left(2, seq(
        field('left', $._expression),
        field('op', choice('*', '/', '%')),
        field('right', $._expression),
      )),
    ),

    // ( expr )
    grouped_expression: $ => seq('(', $._expression, ')'),

    // if condition { expr } else { expr }
    if_expression: $ => seq(
      'if',
      optional('('),
      field('condition', $.condition),
      optional(')'),
      '{',
      field('then_expr', $._expression),
      '}',
      'else',
      '{',
      field('else_expr', $._expression),
      '}',
    ),

    // fn(ctx: DecoratorContext): Decorator { … }
    // fn(x: int, y: int): int { return x + y; }
    // Anonymous function expression (lambda / closure).
    // Used as a value: `return fn(…) { … }`, `const f = fn(…) { … }`,
    //                  `call(fn(…) { … })`.
    fn_expression: $ => seq(
      $.fn_keyword,
      '(',
      optional($.parameter_list),
      ')',
      optional(seq(':', field('return_type', $.type_reference))),
      field('body', $.block),
    ),

    // self.compute(x)  /  self.data.last()  (self + chain)
    chained_member_call_expression: $ => seq(
      $.self_expression,
      repeat1(seq('.', field('step', $.identifier))),
      '(',
      optional(seq($._expression, repeat(seq(',', $._expression)))),
      ')',
    ),

    // g.compute(x)
    member_call_expression: $ => seq(
      field('namespace', $.identifier),
      '.',
      field('member', $.identifier),
      '(',
      optional(seq($._expression, repeat(seq(',', $._expression)))),
      ')',
    ),

    // ctx.isActive  /  p.x  /  result.ok  — property read without `()`
    // Disambiguated from member_call_expression by the absence of `(` after property.
    member_access_expression: $ => seq(
      field('object', $.identifier),
      '.',
      field('property', $.identifier),
    ),

    // add(x, 1)
    call_expression: $ => seq(
      field('callee', $.identifier),
      '(',
      optional(seq($._expression, repeat(seq(',', $._expression)))),
      ')',
    ),

    string_literal: _ => token(seq(
      '"',
      repeat(choice(/[^"\\]/, /\\./)),
      '"',
    )),

    number_literal: _ => /[0-9]+(\.[0-9]+)?/,

    bool_literal: _ => choice('true', 'false'),

    // TypeName { field: expr, field: expr }  /  Self { field: expr }
    struct_literal: $ => seq(
      field('type_name', $.identifier),
      '{',
      optional(seq(
        $.struct_field_init,
        repeat(seq(',', $.struct_field_init)),
        optional(','),
      )),
      '}',
    ),

    struct_field_init: $ => seq(
      field('name', $.identifier),
      ':',
      field('value', $._expression),
    ),

    // []  — empty array; type inferred from context
    empty_array_literal: _ => seq('[', ']'),

    // ── Switch expression ─────────────────────────────────────────────────────
    // switch subject { arm  arm  …  }           ← block bodies, no commas
    // switch subject { arm, arm, else => x, }   ← expression bodies, commas
    // Both styles may be mixed freely; comma is a per-arm trailing token.
    switch_expression: $ => seq(
      $.switch_keyword,
      field('subject', $._expression),
      '{',
      repeat1($.switch_arm),
      '}',
    ),

    switch_keyword: _ => 'switch',

    // Pattern => expr[,]   /   Pattern => { block }[,]
    // The trailing comma is optional so that both:
    //   "up" => { state = state.up(); }    ← block arm, no comma
    //   Direction::North => "north",       ← expression arm, comma
    // parse correctly in the same switch body.
    switch_arm: $ => seq(
      field('pattern', $._switch_pattern),
      '=>',
      field('body', choice($.block, $._expression)),
      optional(','),
    ),

    _switch_pattern: $ => choice(
      $.enum_pattern,           // Name::Variant or Name::Variant(bindings)
      $.string_literal,         // "foo"
      $.number_literal,         // 42
      $.bool_literal,           // true / false
      alias('else', $.else_pattern),  // catch-all
      alias('_', $.wildcard_pattern), // wildcard
    ),

    else_pattern:     _ => 'else',
    wildcard_pattern: _ => '_',

    // Direction::North  /  Shape::Circle(r)  /  Result::Err(_)
    enum_pattern: $ => seq(
      field('enum_name', $.identifier),
      '::',
      field('variant', $.identifier),
      optional(seq(
        '(',
        field('binding', $.enum_binding),
        repeat(seq(',', field('binding', $.enum_binding))),
        ')',
      )),
    ),

    enum_binding: $ => choice(
      alias('_', $.wildcard_pattern),
      field('name', $.identifier),
    ),

    // ── Enum constructor expression ───────────────────────────────────────────
    //   Direction::North         ← unit variant
    //   Shape::Circle(5.0)       ← variant with arguments
    enum_constructor: $ => seq(
      field('enum_name', $.identifier),
      '::',
      field('variant', $.identifier),
      optional(seq(
        '(',
        optional(seq(
          $._expression,
          repeat(seq(',', $._expression)),
          optional(','),
        )),
        ')',
      )),
    ),

    // self — current instance reference inside extension methods
    self_expression: $ => $.self_keyword,
    self_keyword: _ => 'self',

    variable_ref: $ => $.identifier,

    // ── Primitives ────────────────────────────────────────────────────────────
    identifier: _ => /[_a-zA-Z][\w_]*/,

    // ── Comments ──────────────────────────────────────────────────────────────
    comment: _ => token(choice(
      seq('#',  /.*/),
      seq('//', /.*/),
      seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'),
    )),
  },
});
