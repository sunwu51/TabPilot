/* eslint-disable react/prop-types, react-hooks/exhaustive-deps */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { Annotation, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as editorPlaceholder
} from "@codemirror/view";
import { useEffect, useRef } from "react";

const External = Annotation.define();
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const postdogEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--c-surface)",
    color: "var(--c-fg)",
    fontSize: "12px"
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--c-fg)" },
  ".cm-line": { padding: "0 10px" },
  ".cm-gutters": {
    backgroundColor: "var(--c-muted)",
    color: "var(--c-fg-muted)",
    borderRight: "1px solid color-mix(in srgb, var(--c-line) 25%, transparent)"
  },
  // Keep the active line translucent: an opaque background is painted above the
  // selection layer and makes selected text look unselected.
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--c-focus) 8%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--c-focus) 14%, transparent)", color: "var(--c-fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--c-focus) 38%, transparent) !important"
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--c-accent) 35%, transparent)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--c-success) 40%, transparent)", outline: "none" },
  ".cm-placeholder": { color: "var(--c-fg-muted)" },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "2px solid var(--c-line)",
    borderRadius: "8px",
    overflow: "hidden",
    backgroundColor: "var(--c-surface)",
    color: "var(--c-fg)",
    boxShadow: "3px 3px 0 0 var(--c-shadow)"
  },
  ".cm-tooltip-autocomplete ul li": { fontFamily: MONO, fontSize: "12px", padding: "2px 8px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--c-primary)", color: "var(--c-on-soft)" },
  ".cm-completionDetail": { color: "var(--c-fg-muted)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-completionInfo": {
    border: "2px solid var(--c-line)",
    borderRadius: "8px",
    backgroundColor: "var(--c-surface)",
    color: "var(--c-fg)"
  }
});

function isDarkTheme() {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced) return forced === "dark";
  return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

// Dark mode: token colors from oneDark (the surface/selection colors above still come from camel tokens).
function themeExtensions() {
  return isDarkTheme()
    ? [oneDark, postdogEditorTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
    : [postdogEditorTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true })];
}

// --- postdog script autocomplete -------------------------------------------------

const fn = (label, detail, info) => ({ label, type: "function", detail, info, apply: `${label}()` });
const prop = (label, detail, info) => ({ label, type: "property", detail, info });

const KV_MEMBERS = kind => [
  fn("set", "(key, value) | ({ k: v })", `Set one ${kind} or many at once: set({ a: "1", b: "2" })`),
  fn("get", "(key)", `Read a ${kind} value`),
  fn("has", "(key)", `Check whether a ${kind} exists`),
  fn("unset", "(...keys)", `Remove one or more ${kind}s`),
  fn("all", "()", `All enabled ${kind}s as an object`)
];

const ENV_MEMBERS = [
  fn("get", "(key)", "Read an environment variable"),
  fn("set", "(key, value) | ({ k: v })", "Write variables to the active environment (await it)"),
  fn("unset", "(...keys)", "Remove variables from the active environment"),
  fn("has", "(key)", "Check whether a variable exists"),
  fn("all", "()", "All enabled variables as an object")
];

const API_TREE = {
  members: [
    prop("env", "environment", "Active environment variables"),
    prop("variables", "environment", "Alias of env"),
    prop("request", "request", "The request about to be sent (mutable in pre script)"),
    prop("response", "response", "Available in post scripts"),
    fn("test", "(name, passed)", "Record a test result"),
    prop("tests", "tests"),
    fn("log", "(...args)", "Write to Script Logs"),
    fn("uuid", "()", "Random UUID"),
    fn("guid", "()", "Random UUID"),
    fn("now", "()", "ISO timestamp"),
    fn("timestamp", "()", "Milliseconds since epoch")
  ],
  children: {
    env: { members: ENV_MEMBERS },
    environment: { members: ENV_MEMBERS },
    variables: { members: ENV_MEMBERS },
    tests: { members: [fn("set", "(name, passed)", "Record a test result")] },
    request: {
      members: [
        prop("method", "string"),
        prop("url", "string"),
        prop("headers", "headers"),
        prop("query", "query params"),
        prop("params", "query params", "Alias of query"),
        prop("body", "body")
      ],
      children: {
        headers: { members: KV_MEMBERS("header") },
        query: { members: KV_MEMBERS("query param") },
        params: { members: KV_MEMBERS("query param") },
        body: {
          members: [
            fn("set", "(text | object, type?)", "Replace the body; objects are sent as JSON"),
            fn("get", "()", "Raw body text"),
            fn("json", "()", "Parsed JSON body (comments allowed)")
          ]
        }
      }
    },
    response: {
      members: [
        prop("status", "number"),
        prop("ok", "boolean"),
        prop("headers", "object"),
        fn("json", "()", "Parsed JSON body"),
        fn("text", "()", "Raw body text")
      ]
    }
  }
};

const GLOBALS = [
  { label: "$", type: "variable", detail: "postdog", info: "Shortcut for postdog" },
  { label: "postdog", type: "variable", detail: "script API" },
  { label: "console", type: "variable" },
  { label: "await", type: "keyword" }
];

function postdogCompletions(context) {
  const word = context.matchBefore(/[\w$.]*$/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const text = word.text;
  const parts = text.split(".");
  if (parts.length === 1) {
    return { from: word.from, options: GLOBALS, validFor: /^[\w$]*$/ };
  }
  const [root, ...rest] = parts;
  if (root !== "$" && root !== "postdog") return null;
  let node = API_TREE;
  for (const key of rest.slice(0, -1)) {
    node = node.children?.[key];
    if (!node) return null;
  }
  const last = rest[rest.length - 1];
  return {
    from: word.to - last.length,
    options: node.members,
    validFor: /^\w*$/
  };
}

// ----------------------------------------------------------------------------------

function buildExtensions({ language, placeholder, onChangeRef, readOnly }) {
  const languageExtensions = language === "json"
    ? [json()]
    : language === "javascript"
      ? [javascript(), javascriptLanguage.data.of({ autocomplete: postdogCompletions })]
      : [];
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    highlightActiveLine(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true }),
    ...languageExtensions,
    keymap.of([...closeBracketsKeymap, ...completionKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
    ...themeExtensions(),
    EditorView.lineWrapping,
    EditorState.tabSize.of(2),
    EditorState.readOnly.of(!!readOnly),
    placeholder ? editorPlaceholder(placeholder) : [],
    EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      if (update.transactions.some(tr => tr.annotation(External))) return;
      onChangeRef.current?.(update.state.doc.toString());
    })
  ];
}

/**
 * CodeMirror editor that fills its container.
 * `docKey` identifies the document: when it changes the editor state (incl. undo
 * history) is rebuilt so undo never jumps across different requests.
 */
export default function CodeEditor({ value, onChange, language = "text", placeholder = "", docKey = "", readOnly = false, className = "" }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const configRef = useRef({ language, placeholder, readOnly });
  configRef.current = { language, placeholder, readOnly };
  onChangeRef.current = onChange;

  function createState(doc) {
    return EditorState.create({
      doc,
      extensions: buildExtensions({ ...configRef.current, onChangeRef })
    });
  }

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const view = new EditorView({ parent: hostRef.current, state: createState(value || "") });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // New document (different request / language): rebuild state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setState(createState(value || ""));
  }, [docKey, language]);

  // Same document changed from outside (format JSON, external update).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const next = value || "";
    if (current === next) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: next }, annotations: External.of(true) });
  }, [value]);

  return <div className={`postdog-code-editor ${className}`} ref={hostRef} />;
}
