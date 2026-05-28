/**
 * runtime/reflection.c — compile-time reflection support
 *
 * Implements the C-side backing for the opaque types exported by
 * stdlib/reflection.code:
 *
 *   Field    — describes one member (field or method) of a struct type.
 *   TypeInfo — snapshot of a type: name + ordered member list.
 *
 * FieldArray has been replaced by the standard PtrArray (runtime/array.c).
 * TypeInfo.fields is now a PtrArray* and all field lists are managed through
 * the shared ptrarray_new / ptrarray_push / ptrarray_get / ptrarray_length API.
 *
 * Field members:
 *   name          — identifier of the member
 *   typeName      — CodeLang type name (field type / method return type)
 *   isProperty    — reserved, always 0
 *   isExportable  — 1 when the method is declared `export`
 *   isFunction    — 0 for struct fields, 1 for methods
 *   isDisposable  — 1 when declared `using` (auto-dispose on scope exit)
 *   isConst       — 1 for `const` fields / `const fn` (comptime) methods
 *   returnType    — same as typeName for fields; declared return type for methods
 *   isInitialized — 1 when the field has a compile-time initializer value
 *   initialValue  — string representation of the initializer (e.g. "[1, 2, 3]")
 *
 * All allocations are heap-allocated and never freed (metadata lives for the
 * entire program run).
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ── Forward-declare PtrArray from array.c ───────────────────────────────── */
/* PtrArray is the shared void*-backed growable array used for Array<T> where
 * T is any pointer / struct type.  The full definition lives in array.c;
 * we only need the opaque pointer here so the linker resolves the symbols. */

typedef struct PtrArray PtrArray;

extern PtrArray *ptrarray_new(void);
extern void      ptrarray_push(PtrArray *a, void *v);
extern int32_t   ptrarray_length(const PtrArray *a);
extern void     *ptrarray_get(const PtrArray *a, int32_t i);

/* ── Field ────────────────────────────────────────────────────────────────── */

typedef struct Field {
    const char *name;
    const char *typeName;
    int32_t     isProperty;
    int32_t     isExportable;
    int32_t     isFunction;
    int32_t     isDisposable;
    int32_t     isConst;
    const char *returnType;
    int32_t     isInitialized;
    const char *initialValue;
} Field;

Field *field_new(const char *name,        const char *typeName,
                 int32_t     isProperty,  int32_t     isExportable,
                 int32_t     isFunction,  int32_t     isDisposable,
                 int32_t     isConst,     const char *returnType,
                 int32_t     isInitialized, const char *initialValue) {
    Field *f        = (Field *)malloc(sizeof(Field));
    f->name          = name;
    f->typeName      = typeName;
    f->isProperty    = isProperty;
    f->isExportable  = isExportable;
    f->isFunction    = isFunction;
    f->isDisposable  = isDisposable;
    f->isConst       = isConst;
    f->returnType    = returnType;
    f->isInitialized = isInitialized;
    f->initialValue  = initialValue;
    return f;
}

const char *field_name(const Field *f)           { return f ? f->name         : ""; }
const char *field_type_name(const Field *f)      { return f ? f->typeName     : ""; }
int32_t     field_is_property(const Field *f)    { return f ? f->isProperty   : 0;  }
int32_t     field_is_exportable(const Field *f)  { return f ? f->isExportable : 0;  }
int32_t     field_is_function(const Field *f)    { return f ? f->isFunction   : 0;  }
int32_t     field_is_disposable(const Field *f)  { return f ? f->isDisposable : 0;  }
int32_t     field_is_const(const Field *f)       { return f ? f->isConst      : 0;  }
const char *field_return_type(const Field *f)    { return f ? f->returnType   : ""; }
int32_t     field_is_initialized(const Field *f) { return f ? f->isInitialized : 0; }
const char *field_get_value(const Field *f)      { return f ? f->initialValue : ""; }

/* ── TypeInfo ─────────────────────────────────────────────────────────────── */

typedef struct TypeInfo {
    const char *name;
    PtrArray   *fields;   /* PtrArray of Field*; replaces the old FieldArray */
} TypeInfo;

TypeInfo *typeinfo_new(const char *name, PtrArray *fields) {
    TypeInfo *ti = (TypeInfo *)malloc(sizeof(TypeInfo));
    ti->name   = name;
    ti->fields = fields;
    return ti;
}

const char *typeinfo_name(const TypeInfo *ti) {
    return ti ? ti->name : "";
}

PtrArray *typeinfo_fields(const TypeInfo *ti) {
    if (!ti || !ti->fields) return ptrarray_new();
    return ti->fields;
}

/**
 * typeinfo_properties — returns a new PtrArray containing only the
 * property (non-function) members of the type.
 */
PtrArray *typeinfo_properties(const TypeInfo *ti) {
    PtrArray *result = ptrarray_new();
    if (!ti || !ti->fields) return result;
    int32_t len = ptrarray_length(ti->fields);
    for (int32_t i = 0; i < len; i++) {
        Field *f = (Field *)ptrarray_get(ti->fields, i);
        if (f && !f->isFunction) ptrarray_push(result, f);
    }
    return result;
}

/**
 * typeinfo_functions — returns a new PtrArray containing only the
 * function (method) members of the type.
 */
PtrArray *typeinfo_functions(const TypeInfo *ti) {
    PtrArray *result = ptrarray_new();
    if (!ti || !ti->fields) return result;
    int32_t len = ptrarray_length(ti->fields);
    for (int32_t i = 0; i < len; i++) {
        Field *f = (Field *)ptrarray_get(ti->fields, i);
        if (f && f->isFunction) ptrarray_push(result, f);
    }
    return result;
}

/* ── FnInfo ───────────────────────────────────────────────────────────────── */
/*
 * Compile-time / runtime snapshot of a function or method declaration.
 * Used by decorators via CompileContext.fnInfo / RuntimeContext.fnInfo.
 *
 * paramNames / paramTypes are parallel arrays of length paramCount.
 * All strings are caller-owned (interned or heap; never freed).
 */

typedef struct ParamInfo {
    const char *name;
    const char *typeName;
    int32_t     hasDefault;
    const char *defaultValue;
} ParamInfo;

typedef struct FnInfo {
    const char   *name;
    int32_t       isConst;
    int32_t       isExport;
    int32_t       paramCount;
    ParamInfo   **params;     /* array of ParamInfo*, length == paramCount */
    const char   *returnType;
} FnInfo;

/* ── ParamInfo constructors / accessors ──────────────────────────────────── */

ParamInfo *paraminfo_new(const char *name, const char *typeName,
                         int32_t hasDefault, const char *defaultValue) {
    ParamInfo *p    = (ParamInfo *)malloc(sizeof(ParamInfo));
    p->name         = name ? name : "";
    p->typeName     = typeName ? typeName : "";
    p->hasDefault   = hasDefault;
    p->defaultValue = defaultValue ? defaultValue : "";
    return p;
}

const char *paraminfo_name(const ParamInfo *p)          { return p ? p->name         : ""; }
const char *paraminfo_type_name(const ParamInfo *p)     { return p ? p->typeName     : ""; }
int32_t     paraminfo_has_default(const ParamInfo *p)   { return p ? p->hasDefault   : 0;  }
const char *paraminfo_default_value(const ParamInfo *p) { return p ? p->defaultValue : ""; }

/* ── FnInfo constructors / accessors ─────────────────────────────────────── */

FnInfo *fninfo_new(const char *name, int32_t isConst, int32_t isExport,
                   int32_t paramCount, ParamInfo **params,
                   const char *returnType) {
    FnInfo *f    = (FnInfo *)malloc(sizeof(FnInfo));
    f->name       = name ? name : "";
    f->isConst    = isConst;
    f->isExport   = isExport;
    f->paramCount = paramCount;
    f->params     = params;
    f->returnType = returnType ? returnType : "void";
    return f;
}

const char *fninfo_name(const FnInfo *f)                        { return f ? f->name        : ""; }
int32_t     fninfo_is_const(const FnInfo *f)                    { return f ? f->isConst     : 0;  }
int32_t     fninfo_is_export(const FnInfo *f)                   { return f ? f->isExport    : 0;  }
int32_t     fninfo_param_count(const FnInfo *f)                 { return f ? f->paramCount  : 0;  }
const char *fninfo_return_type(const FnInfo *f)                 { return f ? f->returnType  : ""; }

const char *fninfo_param_name(const FnInfo *f, int32_t i) {
    if (!f || i < 0 || i >= f->paramCount || !f->params) return "";
    return f->params[i] ? f->params[i]->name : "";
}

const char *fninfo_param_type(const FnInfo *f, int32_t i) {
    if (!f || i < 0 || i >= f->paramCount || !f->params) return "";
    return f->params[i] ? f->params[i]->typeName : "";
}
