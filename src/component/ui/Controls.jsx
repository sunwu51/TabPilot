/* eslint-disable react/prop-types */
import { Button, Checkbox, Input, Select } from "@sunwu51/camel-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./controls.css";

/**
 * Controlled, type-to-filter combobox styled with camel's combobox classes.
 * (camel's own Combobox cannot show an initial selection and copies `items` only once.)
 *
 * options: [{ value, label, hint?, keywords? }] — the query is split on spaces and every token
 * must appear in label / hint / keywords (case-insensitive). `hint` is shown muted in the list.
 * While typing, the current selection stays visible as the placeholder.
 */
export function UiCombobox({ value, options, onChange, placeholder = "", ariaLabel, className = "", size, maxResults = 200, emptyText = "No matches" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();
  const selected = options.find(option => option.value === value) || null;

  const matches = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return options;
    return options.filter(option => {
      const haystack = `${option.label} ${option.hint || ""} ${option.keywords || ""}`.toLowerCase();
      return tokens.every(token => haystack.includes(token));
    });
  }, [options, query]);
  const shown = matches.length > maxResults ? matches.slice(0, maxResults) : matches;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector("[data-highlighted]")?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  function openList() {
    setQuery("");
    const index = options.findIndex(option => option.value === value);
    setHighlight(index >= 0 && index < maxResults ? index : 0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  function choose(option) {
    if (!option) return;
    close();
    inputRef.current?.blur();
    if (option.value !== value) onChange(option.value);
  }

  function onKeyDown(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight(index => shown.length ? (index + delta + shown.length) % shown.length : 0);
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      choose(shown[highlight]);
    } else if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      inputRef.current?.blur();
    }
  }

  return (
    <div className={`combobox-container ui-combobox${size === "sm" ? " combobox-sm" : ""} ${className}`}>
      <div>
        <div className="combobox-input">
          <input
            ref={inputRef}
            role="combobox"
            aria-label={ariaLabel || placeholder || "combobox"}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && shown[highlight] ? `${listId}-${highlight}` : undefined}
            value={open ? query : selected?.label || ""}
            placeholder={selected?.label || placeholder}
            title={selected?.label || ""}
            spellCheck={false}
            autoComplete="off"
            onFocus={openList}
            onBlur={close}
            onChange={event => {
              setQuery(event.target.value);
              setHighlight(0);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={ariaLabel || "toggle"}
            aria-expanded={open}
            onMouseDown={event => event.preventDefault()}
            onClick={() => (open ? close() : inputRef.current?.focus())}
          >
            <svg className="arrow" width={size === "sm" ? 16 : 20} height={size === "sm" ? 16 : 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </div>
      </div>
      <div className="listbox" hidden={!open}>
        <ul id={listId} role="listbox" ref={listRef}>
          {open && shown.map((option, index) => (
            <li
              key={`${option.value}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              data-highlighted={index === highlight || undefined}
              onMouseDown={event => event.preventDefault()}
              onMouseMove={() => { if (index !== highlight) setHighlight(index); }}
              onClick={() => choose(option)}
            >
              <span className="ui-combobox-label">{option.label}</span>
              {option.hint && <span className="ui-combobox-hint">{option.hint}</span>}
            </li>
          ))}
          {open && shown.length === 0 && <li className="ui-combobox-empty" aria-disabled="true">{emptyText}</li>}
          {open && matches.length > shown.length && (
            <li className="ui-combobox-empty" aria-disabled="true">+{matches.length - shown.length} …</li>
          )}
        </ul>
      </div>
    </div>
  );
}

/** camel-ui Button (sm by default; use size="md" next to Inputs / Selects) with an onClick-style API. variant: primary | danger | success | neutral */
export function UiButton({ variant = "neutral", size = "sm", onClick, disabled, className = "", children, ...rest }) {
  return (
    <Button size={size === "md" ? undefined : size} variant={variant} onPress={onClick} isDisabled={disabled} className={className} {...rest}>
      {children}
    </Button>
  );
}

/** camel-ui Input with a (value: string) => void onChange. */
export function UiInput({ value, onChange, placeholder, label, ariaLabel, className = "", inputClassName = "", onKeyDown, autoFocus, type, size }) {
  return (
    <Input
      className={className}
      size={size}
      inputClassName={inputClassName}
      label={label}
      aria-label={label ? undefined : ariaLabel || placeholder || "input"}
      value={value ?? ""}
      onChange={onChange}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      type={type}
      spellCheck={false}
      autoComplete="off"
    />
  );
}

/**
 * camel-ui Select driven by value. camel-ui's Select is uncontrolled, so it is re-mounted
 * (via `key`) whenever the selected value or the option list changes from outside.
 * options: [{ value, label }]. Labels are de-duplicated so equal names stay selectable.
 */
export function UiSelect({ value, options, onChange, className = "", ariaLabel, label, size }) {
  const labels = useMemo(() => {
    const seen = new Map();
    return options.map(option => {
      const base = String(option.label ?? option.value);
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      return count > 1 ? `${base} (${count})` : base;
    });
  }, [options]);
  const index = Math.max(0, options.findIndex(option => option.value === value));
  return (
    <Select
      key={`${value}|${labels.join("\u0001")}`}
      className={className}
      size={size}
      aria-label={ariaLabel}
      label={label}
      items={labels}
      defaultIndex={index}
      onSelectedItemChange={changes => {
        const next = options[labels.indexOf(changes?.selectedItem)];
        if (next && next.value !== value) onChange(next.value);
      }}
    />
  );
}

/** camel-ui Checkbox without a text label. */
export function UiCheck({ checked, onChange, title, ariaLabel }) {
  return (
    <span className="ui-check" title={title}>
      <Checkbox isSelected={checked} onChange={onChange} aria-label={ariaLabel || title || "toggle"} />
    </span>
  );
}
