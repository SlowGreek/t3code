import { describe, expect, it } from "vite-plus/test";
import { parseMcpToolArguments } from "./CodexMcpDialog";

describe("parseMcpToolArguments", () => {
  it("accepts empty and structured JSON arguments", () => {
    expect(parseMcpToolArguments("")).toEqual({});
    expect(parseMcpToolArguments('{ "path": "README.md", "limit": 10 }')).toEqual({
      path: "README.md",
      limit: 10,
    });
  });

  it("rejects malformed direct invocation arguments", () => {
    expect(() => parseMcpToolArguments("{oops")).toThrow();
  });
});
