import { describe, expect, it } from "vite-plus/test";
import { buildReviewTarget } from "./ReviewStartDialog";

describe("buildReviewTarget", () => {
  it("builds every native Codex review target", () => {
    expect(buildReviewTarget({ type: "uncommittedChanges", value: "", commitTitle: "" })).toEqual({
      type: "uncommittedChanges",
    });
    expect(buildReviewTarget({ type: "baseBranch", value: " main ", commitTitle: "" })).toEqual({
      type: "baseBranch",
      branch: "main",
    });
    expect(buildReviewTarget({ type: "commit", value: " abc123 ", commitTitle: " Fix " })).toEqual({
      type: "commit",
      sha: "abc123",
      title: "Fix",
    });
    expect(buildReviewTarget({ type: "custom", value: " Check auth ", commitTitle: "" })).toEqual({
      type: "custom",
      instructions: "Check auth",
    });
  });

  it("rejects targets that require missing input", () => {
    expect(buildReviewTarget({ type: "baseBranch", value: " ", commitTitle: "" })).toBeNull();
    expect(buildReviewTarget({ type: "commit", value: "", commitTitle: "" })).toBeNull();
    expect(buildReviewTarget({ type: "custom", value: "", commitTitle: "" })).toBeNull();
  });
});
