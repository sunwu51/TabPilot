/* eslint-disable react/prop-types */
import { Button, Checkbox, Input, Select } from "@sunwu51/camel-ui";
import { useMemo } from "react";

/** camel-ui Button (sm by default; use size="md" next to Inputs / Selects) with an onClick-style API. variant: primary | danger | success | neutral */
export function PdButton({ variant = "neutral", size = "sm", onClick, disabled, className = "", children, ...rest }) {
  return (
    <Button size={size === "md" ? undefined : size} variant={variant} onPress={onClick} isDisabled={disabled} className={className} {...rest}>
      {children}
    </Button>
  );
}

/** camel-ui Input with a (value: string) => void onChange. */
export function PdInput({ value, onChange, placeholder, label, ariaLabel, className = "", inputClassName = "", onKeyDown, autoFocus, type }) {
  return (
    <Input
      className={className}
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
export function PdSelect({ value, options, onChange, className = "", ariaLabel }) {
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
      aria-label={ariaLabel}
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
export function PdCheck({ checked, onChange, title, ariaLabel }) {
  return (
    <span className="pd-check" title={title}>
      <Checkbox isSelected={checked} onChange={onChange} aria-label={ariaLabel || title || "toggle"} />
    </span>
  );
}
