/* eslint-disable react/prop-types */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetChromeMock } from "../../test/setup";

vi.mock("@sunwu51/camel-ui", () => ({
  Button: ({ children, onPress, isDisabled, className }) => (
    <button type="button" onClick={onPress} disabled={isDisabled} className={className}>{children}</button>
  ),
  Checkbox: ({ children, isSelected, onChange }) => (
    <label><input type="checkbox" checked={!!isSelected} onChange={(event) => onChange?.(event.target.checked)} />{children}</label>
  ),
  Dialog: ({ children }) => <div>{children}</div>,
  Input: ({ label, defaultValue, onChange }) => (
    <label>{label}<input defaultValue={defaultValue} onChange={(event) => onChange?.(event.target.value)} /></label>
  ),
  Select: ({ label, items, defaultIndex, onSelectedItemChange }) => (
    <label>
      {label}
      <select
        defaultValue={defaultIndex !== undefined ? items[defaultIndex] : undefined}
        onChange={(event) => onSelectedItemChange?.({ selectedItem: event.target.value })}
      >
        {items.map((item, index) => <option key={index} value={item}>{item}</option>)}
      </select>
    </label>
  )
}));

vi.mock("react-hot-toast", () => ({
  default: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }
}));

vi.mock("./MemoryManager", () => ({ default: () => null }));

const { default: SettingsDialog } = await import("./SettingsDialog");
const { LocaleProvider } = await import("../i18n");

afterEach(() => {
  cleanup();
});

describe("SettingsDialog model forms", () => {
  it("does not duplicate the LLM edit form when the image edit form re-renders", async () => {
    resetChromeMock({
      llmConfig: {
        activeLlmModelId: "llm_a",
        llmModels: [
          { id: "llm_a", name: "gpt-5.5", apiType: "openai-responses", baseUrl: "https://api.openai.com/v1/responses", apiKey: "sk-a", model: "gpt-5.5" },
          { id: "llm_b", name: "gpt-6-astra", apiType: "openai-responses", baseUrl: "https://api.openai.com/v1/responses", apiKey: "sk-b", model: "gpt-6-astra" }
        ],
        activeImageModelId: "img_a",
        imageModels: [
          { id: "img_a", name: "gpt-image-2", imageApiProtocol: "openai_builtin_image_gen", sourceLlmModelId: "llm_a", imageModel: "gpt-image-2" }
        ]
      }
    });
    const { container } = render(<LocaleProvider><SettingsDialog /></LocaleProvider>);

    fireEvent.click(await screen.findByLabelText("编辑 gpt-5.5"));
    fireEvent.click(screen.getByLabelText("编辑 gpt-image-2"));
    const hostSelect = await screen.findByLabelText("OpenAI 宿主模型");

    // One LLM edit form plus one image edit form.
    const countModelForms = () => container.querySelectorAll(".settings-model-form").length;
    expect(countModelForms()).toBe(2);

    for (const option of ["gpt-6-astra (gpt-6-astra)", "gpt-5.5 (gpt-5.5)", "gpt-6-astra (gpt-6-astra)"]) {
      fireEvent.change(screen.getByLabelText("OpenAI 宿主模型"), { target: { value: option } });
      expect(countModelForms()).toBe(2);
    }
    expect(screen.getAllByLabelText("OpenAI 宿主模型")).toEqual([hostSelect]);
  });
});
