import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "../executor";
import { requestBackground } from "../../../background/requests";

vi.mock("../../../background/requests", () => ({ requestBackground: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  requestBackground.mockResolvedValue({ success: true, data: { id: "result" } });
});

describe("Postdog management tools", () => {
  it.each(["folder", "request", "environment"])("routes deletion of a %s", async entity => {
    expect(await executeTool(`postdog_delete_${entity}`, { id: "target" }))
      .toEqual({ [entity]: { id: "result" } });
    expect(requestBackground).toHaveBeenCalledWith({ type: "postdog_manager", action: `delete_${entity}`, payload: { id: "target" } });
  });

  it("sets a single variable including empty values and flags", async () => {
    await executeTool("postdog_set_environment_variable", { environmentId: "e1", key: "token", value: "", enabled: false, secret: true });
    expect(requestBackground).toHaveBeenCalledWith({ type: "postdog_manager", action: "set_environment_variable", payload: {
      environmentId: "e1", key: "token", value: "", options: { enabled: false, secret: true }
    } });
  });

  it("deletes only the specified variable", async () => {
    await executeTool("postdog_delete_environment_variable", { environmentId: "e1", key: "token" });
    expect(requestBackground).toHaveBeenCalledWith({ type: "postdog_manager", action: "delete_environment_variable", payload: { environmentId: "e1", key: "token" } });
  });

  it.each([
    ["postdog_delete_folder", {}], ["postdog_delete_request", { id: " " }],
    ["postdog_delete_environment", {}],
    ["postdog_set_environment_variable", { environmentId: "e1", key: "token" }],
    ["postdog_delete_environment_variable", { key: "token" }]
  ])("rejects invalid arguments to %s before dispatch", async (name, args) => {
    expect(await executeTool(name, args)).toHaveProperty("error");
    expect(requestBackground).not.toHaveBeenCalled();
  });
});
