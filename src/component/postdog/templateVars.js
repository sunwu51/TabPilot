import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, ViewPlugin, hoverTooltip } from "@codemirror/view";
import { tr } from "../../i18n";

/**
 * `{{name}}` support for the request body editor:
 *  - typing `{{` offers the active environment's variables (and `$uuid()` style helpers);
 *  - existing `{{name}}` are underlined, and hovering one shows its current value.
 *
 * Variables live in editor state as { [name]: { value, secret } } and are replaced with `setTemplateVars`.
 */

export const setTemplateVars = StateEffect.define();

const varsField = StateField.define({
  create: () => ({}),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setTemplateVars)) return effect.value || {};
    return value;
  }
});

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const BUILTINS = [
  { name: "$uuid()", detail: () => tr("随机 UUID", "random UUID"), preview: () => crypto.randomUUID?.() || "" },
  { name: "$guid()", detail: () => tr("随机 UUID", "random UUID"), preview: () => crypto.randomUUID?.() || "" },
  { name: "$now()", detail: () => tr("当前时间 (ISO)", "current time (ISO)"), preview: () => new Date().toISOString() },
  { name: "$timestamp()", detail: () => tr("当前毫秒时间戳", "current timestamp (ms)"), preview: () => String(Date.now()) }
];

function builtinFor(name) {
  const normalized = name.replace(/^\$/, "").toLowerCase();
  return BUILTINS.find(item => item.name.replace(/^\$/, "") === normalized) || null;
}

function classify(name, vars) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return "var";
  if (builtinFor(name)) return "builtin";
  return "missing";
}

function truncate(text, max = 40) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ------------------------------------------------------------------ completion

function templateCompletions(context) {
  const match = context.matchBefore(/\{\{\s*[^{}\s]*$/);
  if (!match) return null;
  const token = /[^{}\s]*$/.exec(match.text)[0];
  const from = match.to - token.length;
  const vars = context.state.field(varsField, false) || {};
  const closed = context.state.sliceDoc(context.pos, context.pos + 2) === "}}";

  const apply = name => (view, _completion, start, end) => {
    // Typing `{{` may already have auto-closed to `{{}}`; reuse that and step past it.
    view.dispatch({
      changes: { from: start, to: end, insert: closed ? name : `${name}}}` },
      selection: { anchor: start + name.length + 2 },
      userEvent: "input.complete"
    });
  };

  const options = [
    ...Object.keys(vars).map(name => ({
      label: name,
      type: "variable",
      detail: vars[name].secret ? tr("敏感", "secret") : truncate(vars[name].value),
      boost: 1,
      apply: apply(name)
    })),
    ...BUILTINS.map(item => ({ label: item.name, type: "function", detail: item.detail(), apply: apply(item.name) }))
  ];
  return { from, options, validFor: /^[^{}\s]*$/ };
}

// ------------------------------------------------------------------ underline

function buildDecorations(view) {
  const vars = view.state.field(varsField, false) || {};
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    TEMPLATE_RE.lastIndex = 0;
    let match;
    while ((match = TEMPLATE_RE.exec(text))) {
      const kind = classify(match[1], vars);
      builder.add(from + match.index, from + match.index + match[0].length, Decoration.mark({ class: `cm-tpl cm-tpl-${kind}` }));
    }
  }
  return builder.finish();
}

const underline = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildDecorations(view);
  }

  update(update) {
    const varsChanged = update.transactions.some(t => t.effects.some(e => e.is(setTemplateVars)));
    if (update.docChanged || update.viewportChanged || varsChanged) this.decorations = buildDecorations(update.view);
  }
}, { decorations: plugin => plugin.decorations });

// ------------------------------------------------------------------ hover

const hover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const vars = view.state.field(varsField, false) || {};
  TEMPLATE_RE.lastIndex = 0;
  let match;
  while ((match = TEMPLATE_RE.exec(line.text))) {
    const start = line.from + match.index;
    const end = start + match[0].length;
    if (pos < start || pos > end) continue;
    const name = match[1];
    const kind = classify(name, vars);
    return {
      pos: start,
      end,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = `cm-tpl-tip ${kind}`;
        const title = document.createElement("div");
        title.className = "cm-tpl-tip-name";
        title.textContent = name;
        const value = document.createElement("div");
        value.className = "cm-tpl-tip-value";
        if (kind === "var") {
          const info = vars[name];
          value.textContent = info.secret ? "••••••" : (info.value === "" ? tr("（空字符串）", "(empty string)") : String(info.value));
          if (info.secret) title.textContent = `${name} · ${tr("敏感", "secret")}`;
        } else if (kind === "builtin") {
          const item = builtinFor(name);
          value.textContent = `${item.preview()}`;
          const note = document.createElement("div");
          note.className = "cm-tpl-tip-note";
          note.textContent = tr(`内置函数 · ${item.detail()} · 每次发送时重新生成`, `Built-in · ${item.detail()} · regenerated on every send`);
          dom.append(title, value, note);
          return { dom };
        } else {
          value.textContent = tr("未定义：发送时会被替换为空字符串", "Not defined: replaced by an empty string when sent");
        }
        dom.append(title, value);
        return { dom };
      }
    };
  }
  return null;
});

/** Extension bundle; `initial` is the starting variable map. */
export function templateVarsExtension(initial = {}) {
  return [
    varsField.init(() => initial),
    EditorState.languageData.of(() => [{ autocomplete: templateCompletions }]),
    underline,
    hover
  ];
}
