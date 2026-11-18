/* eslint-disable react/prop-types */
// Lightweight stand-ins for @sunwu51/camel-ui in jsdom tests:
//   vi.mock("@sunwu51/camel-ui", async () => await import("../test/camelUiMock"));
// They keep the real components' prop contracts (onPress, isDisabled, string onChange,
// items + onSelectedItemChange ...) but render plain DOM so tests can query by role.

export const Button = ({ children, onPress, isDisabled, className, title, ...rest }) => (
  <button type="button" onClick={onPress} disabled={isDisabled} className={className} title={title} aria-label={rest["aria-label"]}>{children}</button>
);

export const Badge = ({ children, className }) => <span className={className}>{children}</span>;

export const Checkbox = ({ children, isSelected, onChange, ...rest }) => (
  <label>
    <input type="checkbox" aria-label={rest["aria-label"]} checked={!!isSelected} onChange={event => onChange?.(event.target.checked)} />
    {children}
  </label>
);

export const Input = ({ label, value, defaultValue, onChange, placeholder, type, className, ...rest }) => (
  <label className={className}>
    {label}
    <input
      type={type}
      aria-label={label ? undefined : rest["aria-label"]}
      placeholder={placeholder}
      value={value}
      defaultValue={defaultValue}
      onChange={event => onChange?.(event.target.value)}
    />
  </label>
);

export const Select = ({ label, items, defaultIndex, onSelectedItemChange, className, ...rest }) => (
  <label className={className}>
    {label}
    <select
      aria-label={label ? undefined : rest["aria-label"]}
      defaultValue={defaultIndex !== undefined ? items[defaultIndex] : undefined}
      onChange={event => onSelectedItemChange?.({ selectedItem: event.target.value })}
    >
      {items.map((item, index) => <option key={index} value={item}>{item}</option>)}
    </select>
  </label>
);

export const Dialog = ({ children }) => <div>{children}</div>;
export const Details = ({ children, title }) => <details><summary>{title}</summary>{children}</details>;
export const Textarea = ({ children, ...rest }) => <textarea defaultValue={children} {...rest} />;
