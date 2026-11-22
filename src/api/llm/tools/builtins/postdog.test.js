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

describe("Postdog flow tools", () => {
  function routeBackground(handlers) {
    requestBackground.mockImplementation(async ({ action, payload }) => handlers[action]
      ? handlers[action](payload)
      : { success: false, error: `unexpected ${action}` });
  }

  it("merges an update into the existing flow so omitted fields are kept", async () => {
    const saved = [];
    routeBackground({
      get_flow: () => ({ success: true, data: { id: "w1", name: "old", preScript: "PRE", postScript: "", steps: [{ id: "s1", type: "request", requestId: "r1" }] } }),
      list_requests_for_ai: () => ({ success: true, data: [{ id: "r1" }] }),
      save_flow: ({ flow }) => { saved.push(flow); return { success: true, data: { id: flow.id } }; },
      get_flow_for_ai: ({ id }) => ({ success: true, data: { id } })
    });
    expect(await executeTool("postdog_save_flow", { flow: { id: "w1", name: "renamed" } })).toEqual({ flow: { id: "w1" } });
    expect(saved[0]).toMatchObject({ id: "w1", name: "renamed", preScript: "PRE", steps: [{ id: "s1", type: "request", requestId: "r1" }] });
  });

  it("rejects unknown step types and request ids before saving", async () => {
    routeBackground({
      list_requests_for_ai: () => ({ success: true, data: [{ id: "r1" }] }),
      save_flow: () => { throw new Error("must not save"); }
    });
    const result = await executeTool("postdog_save_flow", { flow: { name: "f", steps: [{ type: "loop" }, { type: "request", requestId: "nope" }] } });
    expect(result.error).toContain("steps[0].type");
    expect(result.error).toContain("unknown requestId: nope");
  });

  it("routes run / list runs / get run with required ids", async () => {
    routeBackground({
      run_flow: payload => ({ success: true, data: { runId: "fr1", payload } }),
      list_flow_runs_for_ai: payload => ({ success: true, data: [payload] }),
      get_flow_run_for_ai: payload => ({ success: true, data: payload })
    });
    expect(await executeTool("postdog_run_flow", { id: "w1" })).toEqual({ run: { runId: "fr1", payload: { id: "w1" } } });
    expect(await executeTool("postdog_list_flow_runs", { flowId: "w1" })).toEqual({ runs: [{ flowId: "w1" }] });
    expect(await executeTool("postdog_get_flow_run", { runId: "fr1" })).toEqual({ run: { runId: "fr1" } });
    requestBackground.mockClear();
    for (const name of ["postdog_run_flow", "postdog_get_flow", "postdog_delete_flow", "postdog_list_flow_runs", "postdog_get_flow_run"]) {
      expect(await executeTool(name, {})).toHaveProperty("error");
    }
    expect(requestBackground).not.toHaveBeenCalled();
  });
});
