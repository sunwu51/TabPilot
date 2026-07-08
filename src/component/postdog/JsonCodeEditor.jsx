/* eslint-disable react/prop-types */
import { json } from "@codemirror/lang-json";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, placeholder as editorPlaceholder } from "@codemirror/view";
import { useEffect, useRef } from "react";

const postdogEditorTheme = EditorView.theme({
  "&": {
    minHeight: "260px",
    backgroundColor: "#ffffff",
    color: "#111827",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    fontSize: "12px"
  },
  "&.cm-focused": {
    outline: "none",
    borderColor: "#2563eb",
    boxShadow: "0 0 0 1px rgba(37, 99, 235, 0.18)"
  },
  ".cm-scroller": {
    minHeight: "260px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.55"
  },
  ".cm-content": {
    minHeight: "260px",
    padding: "10px 0",
    caretColor: "#111827"
  },
  ".cm-line": {
    padding: "0 12px"
  },
  ".cm-gutters": {
    backgroundColor: "#f8fafc",
    color: "#64748b",
    borderRight: "1px solid #e5e7eb"
  },
  ".cm-activeLine": {
    backgroundColor: "#eff6ff"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#dbeafe"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#bfdbfe"
  },
  ".cm-placeholder": {
    color: "#9ca3af"
  }
}, { dark: false });

export default function JsonCodeEditor({ value, onChange, placeholder = "" }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value || "");
  const placeholderRef = useRef(placeholder);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          json(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          postdogEditorTheme,
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          placeholderRef.current ? editorPlaceholder(placeholderRef.current) : [],
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          })
        ]
      })
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const next = value || "";
    if (current === next) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: next }
    });
  }, [value]);

  return <div className="postdog-json-code-editor" ref={hostRef} />;
}
