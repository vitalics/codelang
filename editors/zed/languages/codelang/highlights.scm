; ── Macros ───────────────────────────────────────────────────────────────────
;
; Declaration:
;   macro assert!($cond: Expr) { … }
;   const macro size_of!($T: Type): const int { … }
;
; Call / invocation:
;   assert!(x > 0)     dbg!(p.sum())

; `macro` keyword
(macro_keyword) @keyword

; macro declaration name: assert, stringify, dbg, …
(macro_declaration name: (identifier) @function.macro)

; `!` bang sigil in declaration and call
(macro_declaration "!" @punctuation.special)
(macro_call_expression "!" @punctuation.special)

; macro call name: assert!, dbg!, log!, size_of!, …
(macro_call_expression name: (identifier) @function.macro)

; macro param names: $cond  $expr  $T  $parts
(macro_param_name) @variable.parameter

; template / interpolated string: $"text {expr} more"
(template_string) @string.special

; ── Decorators ───────────────────────────────────────────────────────────────
;
; Applicable to: type, fn, enum, variable declaration, parameter, struct field.
;
;   @derive(Displayable, Serialize)  ← identifier args (protocol names)
;   @doc("text")                     ← string arg
;   @json(skip)                      ← bare identifier arg
;   @json(skipIf = "cond")           ← named string arg
;   @log                             ← no args

; `@` sigil
(decorator "@" @punctuation.special)

; decorator name: @derive, @log, @doc, @json, …
(decorator name: (identifier) @attribute)

; decorator_arg: the key in a named arg  (@json(skipIf = "…") → skipIf @property)
(decorator_arg key: (identifier) @property)

; decorator_arg identifier value: protocol / trait name  (@derive(Displayable) → @type)
(decorator_arg value: (identifier) @type)

; decorator_arg string value: documentation, conditions, …  (@doc("text") → @string)
(decorator_arg value: (string_literal) @string)

; decorator_arg number value:  @version(2) → @number
(decorator_arg value: (number_literal) @number)

; ── Keywords ────────────────────────────────────────────────────────────────

(export_keyword)    @keyword          ; export fn / export const fn / export extern fn
(extern_keyword)    @keyword          ; extern fn …;
(const_keyword)     @keyword          ; const fn / const param / const var
(let_keyword)       @keyword          ; let var
(fn_keyword)        @keyword.function
(import_keyword)    @keyword.import   ; import "…"  /  const g = import "…"
(type_keyword)      @keyword.type     ; type X = …
(enum_keyword)      @keyword.type     ; enum Direction { … }
(switch_keyword)    @keyword.conditional ; switch x { … }
(intrinsic_keyword) @keyword.builtin  ; intrinsic("i32")
(protocol_keyword)  @keyword          ; protocol Foo { … }
(extends_keyword)   @keyword          ; Boolean extends ToString { … }
(static_keyword)    @keyword          ; export static fn / export static const
(using_keyword)     @keyword          ; using conn = openConnection()
(static_keyword)    @keyword          ; export static fn …
(void_type)         @type.builtin     ; void
"return"            @keyword.return
"if"                @keyword.conditional
"else"              @keyword.conditional
(while_keyword)     @keyword.repeat   ; while …
(for_keyword)       @keyword.repeat   ; for (…; …; …) { … }
(break_keyword)     @keyword.repeat   ; break
(continue_keyword)  @keyword.repeat   ; continue
(panic_keyword)     @function.builtin ; panic("msg")
(defer_keyword)     @keyword          ; defer expr

; ── Built-in function ────────────────────────────────────────────────────────

(print_keyword) @function.builtin

; ── Import forms ─────────────────────────────────────────────────────────────

; import "./greetings";
; └── source string → @string.special  (module path)
(bare_import
  source: (string_literal) @string.special)

; const g = import "./math";
; └── g (namespace binding) → @namespace
; └── source string → @string.special
(namespace_import
  name: (identifier) @namespace)
(namespace_import
  source: (string_literal) @string.special)

; const io = switch_import! compile.arch() { "arm64" => "stdlib/io", else => "stdlib/io" };
; └── io (namespace binding)    → @namespace
; └── switch_import keyword     → @keyword.import
; └── `!` sigil                 → @punctuation.special
; └── arm source strings        → @string.special  (module paths)
; └── `=>` fat arrow            → @operator
(switch_import_declaration
  name: (identifier) @namespace)
(switch_import_keyword) @keyword.import
(switch_import_expression "!" @punctuation.special)
(switch_import_arm "=>" @operator)
(switch_import_arm
  source: (string_literal) @string.special)

; ── Type declarations ────────────────────────────────────────────────────────

(type_declaration
  name: (identifier) @type.definition)

; Generic type parameters: type Function<A, R>  /  fn map<A, B>(…)
;   A, R, B  → @type.parameter (italic in most themes — marks a type variable)
(type_param
  name: (identifier) @type.parameter)

; Bounds on type parameters:
;   A extends Any[]          ← single atom
;   A extends Any[] | Any    ← union bound (type_bound has repeat of type_bound_atom)
;   T extends Comparable
;
; 1. `extends` inside a type_param bound is an anonymous token (not extends_keyword).
;    Capture it explicitly so it gets keyword colour.
(type_param "extends" @keyword.type)

; 2. `|` between bound atoms: Any[] | Any
(type_bound "|" @operator)

; 3. `[]` suffix on a bound atom: Any[]
(type_bound_atom "[" @punctuation.bracket "]" @punctuation.bracket)

; 4. type_bound_atom name (Any, Comparable, …) → @type
(type_bound_atom
  name: (identifier) @type)

; extends Callable<A, R> on a type declaration — `extends` is also anonymous here
(type_extends_clause "extends" @keyword.type)
(type_extends_clause
  parent: (identifier) @type)

; alias_body is now a full type_reference; its contents are highlighted
; by the type_name / generic_type / fn_type / array_type rules below.

(type_name
  (identifier) @type)

; int[]  /  int[N]  — array type shorthand: element type name
(array_type
  element: (identifier) @type)

; Array<int>  /  Box<string> — generic type name and its arguments
(generic_type
  name: (identifier) @type)

(generic_type
  type_arg: (_) @type)

; fn(int): int  /  fn(A, B): C  — function types used in type aliases and params
;   The fn keyword is already captured by (fn_keyword) @keyword.function above.
;   Named fn-type params: fn(acc: int, val: int): int  →  acc, val @variable.parameter
(fn_type_param
  name: (identifier) @variable.parameter)

; fn(...A): R — spread type parameter: highlight spread type ref as @type.parameter
;   '...' is an anonymous token; the spread field is the type_reference after it.
(fn_type
  spread: (type_reference) @type.parameter)

; ── Struct type declarations ─────────────────────────────────────────────────

; struct method names (inside type { ... })
(struct_method
  name: (identifier) @function.method)

; callable method — method without `fn` keyword inside Callable types
;   call(value: int): int { … }
(callable_method
  name: (identifier) @function.method)

; struct field names: data: IntArray
(field_declaration
  name: (identifier) @variable.member)

; struct literal type name: Self { ... } / Point { ... }
(struct_literal
  type_name: (identifier) @type)

; struct field init name: data: []
(struct_field_init
  name: (identifier) @variable.member)

; ── Function declarations ────────────────────────────────────────────────────

(function_declaration
  name: (identifier) @function)

; ── Extern declarations ───────────────────────────────────────────────────────

(extern_declaration
  name: (identifier) @function)

; ── Protocol declarations ────────────────────────────────────────────────────

; protocol name → @type.definition
(protocol_declaration
  name: (identifier) @type.definition)

; protocol extends clause: protocol Error extends Displayable
(protocol_declaration
  extends_protocol: (identifier) @type)

; abstract field inside protocol → @variable.member
;   const name: string,   /   stacktrace: Option<T>,
(protocol_field
  name: (identifier) @variable.member)

; method signature inside protocol → @function
(method_signature
  name: (identifier) @function)

; ── Extension declarations ───────────────────────────────────────────────────

; Boolean extends ToString — type name → @type, protocol name → @type
; Function<A extends Any[] | Any, R> extends Callable<A, R> { … }
;   type_name → @type, type_params → handled by (type_param) rule above,
;   protocol  → @type
(extension_declaration
  type_name: (identifier) @type)

(extension_declaration
  protocol: (identifier) @type)

; methods defined inside an extension
(extension_method
  name: (identifier) @function.method)

; ── Enum declarations ─────────────────────────────────────────────────────────

; enum name → @type.definition
(enum_declaration
  name: (identifier) @type.definition)

; enum protocol bound:  enum Color extends Displayable { … }
(enum_declaration
  protocol: (identifier) @type)

; variant names → @constant (enum variants are constant constructors)
(enum_variant
  name: (identifier) @constant)

; variant payload types → handled by type_reference rules (@type)

; methods inside an enum body
(enum_method
  name: (identifier) @function.method)

; ── Enum constructor & pattern matching ──────────────────────────────────────

; Direction::North  /  Shape::Circle(5.0)
;   enum name → @type,  variant → @constant
(enum_constructor
  enum_name: (identifier) @type)

(enum_constructor
  variant: (identifier) @constant)

; "::" separator in constructor and pattern
(enum_constructor "::" @punctuation.delimiter)
(enum_pattern    "::" @punctuation.delimiter)

; ── Switch expression ─────────────────────────────────────────────────────────

(switch_keyword) @keyword.conditional  ; switch subject { … }

; "else" catch-all arm
(else_pattern) @keyword.conditional

; "=>" fat arrow between pattern and body
(switch_arm "=>" @operator)

; enum_pattern:  Direction::North  /  Shape::Circle(r)
(enum_pattern
  enum_name: (identifier) @type)

(enum_pattern
  variant: (identifier) @constant)

; bindings in enum patterns: Shape::Rect(w, h)  /  Result::Err(_)
(enum_binding
  name: (identifier) @variable)

(wildcard_pattern) @variable.builtin  ; _ — discard binding

; ── Member access ────────────────────────────────────────────────────────────

; ctx.isActive  /  p.x  /  result.ok  — property read without ()
(member_access_expression
  object:   (identifier) @variable)
(member_access_expression
  property: (identifier) @variable.member)

; ── self reference ───────────────────────────────────────────────────────────

(self_keyword) @variable.builtin

; ── Function calls ───────────────────────────────────────────────────────────

(call_statement
  callee: (identifier) @function.call)

(call_expression
  callee: (identifier) @function.call)

; g.greet() — namespace highlighted as @namespace, member as @function.call
(member_call_statement
  namespace: (identifier) @namespace
  member:    (identifier) @function.call)

(member_call_expression
  namespace: (identifier) @namespace
  member:    (identifier) @function.call)

; self.data.push(item) — each step after self highlighted as @function.call
(chained_member_call_statement
  step: (identifier) @function.call)

(chained_member_call_expression
  step: (identifier) @function.call)

; ── Parameters ───────────────────────────────────────────────────────────────

(parameter
  name: (identifier) @variable.parameter)

; ── Variable / resource declarations ────────────────────────────────────────

; const binding — immutable
(variable_declaration
  (const_keyword)
  name: (identifier) @constant)

; let binding — mutable
(variable_declaration
  (let_keyword)
  name: (identifier) @variable)

; using binding — RAII resource
(using_declaration
  name: (identifier) @variable)

; static property inside an extension
(static_property
  name: (identifier) @constant)

; ── Assignment targets ───────────────────────────────────────────────────────

(assignment_statement
  target: (identifier) @variable)

; ── Variable references ──────────────────────────────────────────────────────

(variable_ref) @variable

; ── Operators ────────────────────────────────────────────────────────────────

(binary_expression op: "+" ) @operator
(binary_expression op: "-" ) @operator
(binary_expression op: "*" ) @operator
(binary_expression op: "/" ) @operator
(binary_expression op: "%" ) @operator

(condition op: "==") @operator
(condition op: "!=") @operator
(condition op: "<" ) @operator
(condition op: ">" ) @operator
(condition op: "<=") @operator
(condition op: ">=") @operator
(condition op: "&&") @operator.logical
(condition op: "||") @operator.logical

(compound_assign_statement op: "+=" @operator)
(compound_assign_statement op: "-=" @operator)
(compound_assign_statement op: "*=" @operator)
(compound_assign_statement op: "/=" @operator)

"="  @operator
"."  @operator
"++" @operator
"--" @operator

; ── Literals ─────────────────────────────────────────────────────────────────

(string_literal)  @string
(number_literal)  @number
(bool_literal)    @constant.builtin

; ── Comments ─────────────────────────────────────────────────────────────────

(comment) @comment

; ── Punctuation ──────────────────────────────────────────────────────────────

["{" "}"] @punctuation.bracket
["(" ")"] @punctuation.bracket
";"        @punctuation.delimiter
":"        @punctuation.delimiter
","        @punctuation.delimiter
