import { describe, expect, it } from "vite-plus/test";
import { nativeThreadTitle } from "./CodexThreadBrowserDialog";

describe("nativeThreadTitle", () => {
  it("prefers native names and falls back to previews", () => {
    const base = {
      providerThreadId: "provider-thread-12345678",
      cwd: "/repo",
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    };
    expect(nativeThreadTitle({ ...base, name: " Native title ", preview: "Preview" })).toBe(
      "Native title",
    );
    expect(nativeThreadTitle({ ...base, name: null, preview: " Preview title " })).toBe(
      "Preview title",
    );
  });
});
