//  SyntaxHighlighter.swift
//  A small, self-contained syntax highlighter — pure Swift, NO resource bundle,
//  NO JavaScriptCore, NO Bundle.module. This is deliberate: the previous
//  Highlightr/highlight.js path fatal-errored in the signed .app because its
//  `Bundle.module` accessor couldn't find its resources (see MarkdownRendering).
//  A heuristic tokenizer can't match highlight.js's 180-language coverage, but it
//  colours the shapes that matter (comments / strings / numbers / keywords /
//  types) across the languages that actually show up in chat, and it can never
//  crash on a missing resource. Colours are mid-saturation so they read on both
//  the light and dark code-block backgrounds.

import SwiftUI

enum CodeTheme {
    static let plain    = Color.primary
    static let comment  = Color(red: 0.55, green: 0.58, blue: 0.62)
    static let keyword  = Color(red: 0.93, green: 0.42, blue: 0.65)   // pink/magenta
    static let string   = Color(red: 0.50, green: 0.76, blue: 0.44)   // green
    static let number   = Color(red: 0.93, green: 0.62, blue: 0.35)   // orange
    static let type     = Color(red: 0.36, green: 0.74, blue: 0.86)   // cyan
    static let function = Color(red: 0.55, green: 0.60, blue: 0.98)   // periwinkle
    static let attribute = Color(red: 0.78, green: 0.55, blue: 0.98)  // violet (json keys / attrs)
}

/// Heuristic, per-language token highlighter. `highlight` returns an
/// `AttributedString` with per-run `foregroundColor`s; nil-safe and total (it
/// never throws / never touches the filesystem).
enum SyntaxHighlighter {

    static func highlight(_ code: String, language: String?) -> AttributedString {
        let lang = normalize(language)
        let spec = LangSpec.spec(for: lang)
        return tokenize(code, spec: spec)
    }

    // MARK: - Language spec

    struct LangSpec {
        var keywords: Set<String>
        var types: Set<String>
        var lineComment: [String]        // e.g. ["//", "#"]
        var blockComment: (open: String, close: String)?
        var stringDelims: [Character]    // e.g. ["\"", "'", "`"]
        var jsonLike: Bool = false       // colour "key": as attribute

        static func spec(for lang: String) -> LangSpec {
            switch lang {
            case "swift":
                return LangSpec(keywords: swiftKw, types: commonTypes,
                                lineComment: ["//"], blockComment: ("/*", "*/"),
                                stringDelims: ["\""])
            case "python", "py":
                return LangSpec(keywords: pyKw, types: pyTypes,
                                lineComment: ["#"], blockComment: nil,
                                stringDelims: ["\"", "'"])
            case "javascript", "js", "typescript", "ts", "jsx", "tsx":
                return LangSpec(keywords: jsKw, types: commonTypes,
                                lineComment: ["//"], blockComment: ("/*", "*/"),
                                stringDelims: ["\"", "'", "`"])
            case "json":
                return LangSpec(keywords: ["true", "false", "null"], types: [],
                                lineComment: [], blockComment: nil,
                                stringDelims: ["\""], jsonLike: true)
            case "bash", "sh", "shell", "zsh":
                return LangSpec(keywords: shKw, types: [],
                                lineComment: ["#"], blockComment: nil,
                                stringDelims: ["\"", "'"])
            case "go":
                return LangSpec(keywords: goKw, types: commonTypes,
                                lineComment: ["//"], blockComment: ("/*", "*/"),
                                stringDelims: ["\"", "`"])
            case "rust", "rs":
                return LangSpec(keywords: rustKw, types: commonTypes,
                                lineComment: ["//"], blockComment: ("/*", "*/"),
                                stringDelims: ["\""])
            case "java", "kotlin", "kt", "c", "cpp", "c++", "cs", "csharp", "objc":
                return LangSpec(keywords: cLikeKw, types: commonTypes,
                                lineComment: ["//"], blockComment: ("/*", "*/"),
                                stringDelims: ["\"", "'"])
            case "sql":
                return LangSpec(keywords: sqlKw, types: [],
                                lineComment: ["--"], blockComment: ("/*", "*/"),
                                stringDelims: ["'", "\""])
            case "yaml", "yml", "toml", "ini":
                return LangSpec(keywords: ["true", "false", "null", "yes", "no"], types: [],
                                lineComment: ["#"], blockComment: nil,
                                stringDelims: ["\"", "'"], jsonLike: true)
            case "html", "xml", "css", "scss":
                return LangSpec(keywords: [], types: [],
                                lineComment: [], blockComment: ("/*", "*/"),
                                stringDelims: ["\"", "'"])
            default:
                // Generic: colour comments / strings / numbers only.
                return LangSpec(keywords: [], types: [],
                                lineComment: ["//", "#"], blockComment: ("/*", "*/"),
                                stringDelims: ["\"", "'", "`"])
            }
        }
    }

    // MARK: - Tokenizer

    private static func tokenize(_ code: String, spec: LangSpec) -> AttributedString {
        var out = AttributedString()
        let chars = Array(code)
        var i = 0
        let n = chars.count

        func append(_ s: String, _ color: Color) {
            var run = AttributedString(s)
            run.foregroundColor = color
            out.append(run)
        }
        func isIdent(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" || c == "$" }

        while i < n {
            let c = chars[i]

            // Block comment
            if let bc = spec.blockComment, matches(chars, i, bc.open) {
                let start = i
                i += bc.open.count
                while i < n, !matches(chars, i, bc.close) { i += 1 }
                if i < n { i += bc.close.count }
                append(String(chars[start..<min(i, n)]), CodeTheme.comment)
                continue
            }
            // Line comment
            if let lc = spec.lineComment.first(where: { matches(chars, i, $0) }) {
                _ = lc
                let start = i
                while i < n, chars[i] != "\n" { i += 1 }
                append(String(chars[start..<i]), CodeTheme.comment)
                continue
            }
            // String
            if spec.stringDelims.contains(c) {
                let delim = c
                let start = i
                i += 1
                while i < n {
                    if chars[i] == "\\", i + 1 < n { i += 2; continue }
                    if chars[i] == delim { i += 1; break }
                    if chars[i] == "\n" { break }   // unterminated single-line string
                    i += 1
                }
                append(String(chars[start..<min(i, n)]), CodeTheme.string)
                continue
            }
            // Number
            if c.isNumber || (c == "." && i + 1 < n && chars[i + 1].isNumber) {
                let start = i
                while i < n, chars[i].isHexDigit || chars[i] == "." || chars[i] == "x"
                        || chars[i] == "b" || chars[i] == "o" || chars[i] == "_"
                        || chars[i] == "e" || chars[i] == "E" { i += 1 }
                append(String(chars[start..<i]), CodeTheme.number)
                continue
            }
            // Identifier / keyword / type / function / json key
            if c.isLetter || c == "_" || c == "@" || c == "#" {
                let start = i
                if c == "@" || c == "#" { i += 1 }   // Swift attribute / directive prefix
                while i < n, isIdent(chars[i]) { i += 1 }
                let word = String(chars[start..<i])
                let bare = word.hasPrefix("@") || word.hasPrefix("#") ? String(word.dropFirst()) : word

                if word.hasPrefix("@") || word.hasPrefix("#") {
                    append(word, CodeTheme.attribute)
                } else if spec.keywords.contains(bare) {
                    append(word, CodeTheme.keyword)
                } else if spec.types.contains(bare) || (bare.first?.isUppercase == true && bare.count > 1) {
                    append(word, CodeTheme.type)
                } else if spec.jsonLike, isJSONKey(chars, afterIdentAt: i) {
                    append(word, CodeTheme.attribute)
                } else if isCallSite(chars, afterIdentAt: i) {
                    append(word, CodeTheme.function)
                } else {
                    append(word, CodeTheme.plain)
                }
                continue
            }
            // Everything else (punctuation / whitespace)
            append(String(c), CodeTheme.plain)
            i += 1
        }
        return out
    }

    // MARK: - Helpers

    private static func matches(_ chars: [Character], _ i: Int, _ s: String) -> Bool {
        let t = Array(s)
        guard i + t.count <= chars.count else { return false }
        for k in 0..<t.count where chars[i + k] != t[k] { return false }
        return true
    }

    /// A "(" (allowing spaces) right after the identifier → a call/definition.
    private static func isCallSite(_ chars: [Character], afterIdentAt i: Int) -> Bool {
        var j = i
        while j < chars.count, chars[j] == " " { j += 1 }
        return j < chars.count && chars[j] == "("
    }

    /// A ":" (allowing spaces) right after the identifier → a json/yaml key.
    private static func isJSONKey(_ chars: [Character], afterIdentAt i: Int) -> Bool {
        var j = i
        while j < chars.count, chars[j] == " " { j += 1 }
        return j < chars.count && chars[j] == ":"
    }

    private static func normalize(_ language: String?) -> String {
        (language ?? "").trimmingCharacters(in: .whitespaces).lowercased()
    }

    // MARK: - Keyword tables

    private static let commonTypes: Set<String> = [
        "Int", "String", "Bool", "Double", "Float", "Void", "Char", "Array", "Dictionary",
        "Set", "Optional", "Any", "Self", "Data", "Date", "URL", "Error", "Result",
    ]
    private static let swiftKw: Set<String> = [
        "func", "let", "var", "if", "else", "guard", "return", "for", "while", "in", "do",
        "try", "catch", "throw", "throws", "async", "await", "class", "struct", "enum",
        "protocol", "extension", "import", "switch", "case", "default", "break", "continue",
        "self", "nil", "true", "false", "init", "deinit", "static", "private", "public",
        "internal", "fileprivate", "open", "final", "lazy", "weak", "unowned", "mutating",
        "override", "some", "where", "as", "is", "typealias", "associatedtype", "defer",
        "repeat", "inout", "rethrows", "convenience", "required", "indirect", "get", "set",
    ]
    private static let pyKw: Set<String> = [
        "def", "class", "if", "elif", "else", "for", "while", "in", "return", "import",
        "from", "as", "try", "except", "finally", "raise", "with", "lambda", "yield",
        "pass", "break", "continue", "and", "or", "not", "is", "None", "True", "False",
        "global", "nonlocal", "assert", "del", "async", "await", "self", "match", "case",
    ]
    private static let pyTypes: Set<String> = [
        "int", "str", "bool", "float", "list", "dict", "set", "tuple", "bytes", "object",
    ]
    private static let jsKw: Set<String> = [
        "function", "const", "let", "var", "if", "else", "for", "while", "do", "return",
        "class", "extends", "new", "this", "super", "import", "export", "from", "default",
        "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break",
        "continue", "typeof", "instanceof", "in", "of", "delete", "void", "yield", "null",
        "undefined", "true", "false", "static", "get", "set", "public", "private", "readonly",
        "interface", "type", "enum", "implements", "namespace", "declare", "as",
    ]
    private static let shKw: Set<String> = [
        "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac",
        "in", "function", "return", "exit", "echo", "export", "local", "readonly", "source",
        "set", "unset", "cd", "then", "sudo", "test",
    ]
    private static let goKw: Set<String> = [
        "func", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer",
        "if", "else", "for", "range", "return", "switch", "case", "default", "break",
        "continue", "package", "import", "nil", "true", "false", "make", "new", "select",
        "goto", "fallthrough",
    ]
    private static let rustKw: Set<String> = [
        "fn", "let", "mut", "const", "static", "if", "else", "for", "while", "loop", "match",
        "return", "struct", "enum", "trait", "impl", "use", "mod", "pub", "crate", "self",
        "super", "where", "async", "await", "move", "ref", "as", "dyn", "true", "false",
        "break", "continue", "unsafe", "type", "in",
    ]
    private static let cLikeKw: Set<String> = [
        "int", "long", "short", "char", "float", "double", "void", "bool", "unsigned",
        "signed", "const", "static", "struct", "class", "enum", "union", "public", "private",
        "protected", "if", "else", "for", "while", "do", "return", "switch", "case", "default",
        "break", "continue", "new", "delete", "this", "null", "nullptr", "true", "false",
        "namespace", "using", "template", "typename", "virtual", "override", "final", "import",
        "package", "extends", "implements", "interface", "throws", "try", "catch", "finally",
        "throw", "var", "val", "fun", "when", "abstract",
    ]
    private static let sqlKw: Set<String> = [
        "select", "from", "where", "insert", "into", "values", "update", "set", "delete",
        "create", "table", "drop", "alter", "add", "join", "left", "right", "inner", "outer",
        "on", "group", "by", "order", "having", "limit", "offset", "as", "and", "or", "not",
        "null", "is", "in", "like", "between", "distinct", "count", "sum", "avg", "min", "max",
        "primary", "key", "foreign", "references", "index", "unique", "default", "and",
        // upper-case variants are common; the tokenizer is case-sensitive, so add them.
        "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
        "CREATE", "TABLE", "DROP", "ALTER", "JOIN", "LEFT", "INNER", "ON", "GROUP", "BY",
        "ORDER", "HAVING", "LIMIT", "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "DISTINCT",
    ]
}
