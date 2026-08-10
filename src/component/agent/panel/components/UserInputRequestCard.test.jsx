/* eslint-disable react/prop-types */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  UserInputRequestCard,
  normalizeUserInputRequest
} from "./UserInputRequestCard";

vi.mock("@sunwu51/camel-ui", () => ({
  Card: ({ children, ...props }) => <div {...props}>{children}</div>,
  Button: ({ children, onPress, isDisabled, ...props }) => (
    <button type="button" onClick={onPress} disabled={isDisabled} {...props}>{children}</button>
  )
}));

const request = {
  questions: [
    {
      id: "language",
      header: "语言",
      question: "使用哪种语言？",
      options: [
        { label: "TypeScript", description: "类型安全" },
        { label: "Python", description: "开发快速" }
      ]
    },
    {
      id: "framework",
      header: "框架",
      question: "使用哪个框架？",
      options: [
        { label: "Fastify", description: "轻量" },
        { label: "Express", description: "生态成熟" }
      ]
    }
  ]
};

describe("normalizeUserInputRequest", () => {
  it("rejects missing questions, duplicate ids, and fewer than two options", () => {
    expect(normalizeUserInputRequest({}).error).toContain("At least one");
    expect(normalizeUserInputRequest({ questions: [
      request.questions[0],
      { ...request.questions[1], id: "language" }
    ] }).error).toContain("unique");
    expect(normalizeUserInputRequest({ questions: [{
      ...request.questions[0],
      options: request.questions[0].options.slice(0, 1)
    }] }).error).toContain("at least two");
  });
});

describe("UserInputRequestCard", () => {
  it("submits selected answers for multiple questions", () => {
    const onSubmit = vi.fn();
    render(<UserInputRequestCard request={request} onSubmit={onSubmit} onCancel={() => {}} />);

    const submit = screen.getByRole("button", { name: "提交" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /TypeScript/ }));
    fireEvent.click(screen.getByRole("button", { name: /Fastify/ }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledWith({ language: "TypeScript", framework: "Fastify" });
  });

  it("requires non-empty text for Other and supports cancellation", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<UserInputRequestCard
      request={{ questions: [request.questions[0]] }}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />);

    fireEvent.click(screen.getByRole("button", { name: /其他/ }));
    const submit = screen.getByRole("button", { name: "提交" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("请输入你的答案"), { target: { value: " Go " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ language: "Go" });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
