import { describe, expect, it } from "vite-plus/test";
import { resolveComposerStructuredInputs } from "./composerStructuredInputs";

const skills = [
  {
    name: "frontend-design",
    path: "/skills/frontend-design/SKILL.md",
    enabled: true,
  },
];

describe("resolveComposerStructuredInputs", () => {
  it("preserves composer order and exact selected paths", () => {
    expect(
      resolveComposerStructuredInputs({
        text: "[App.tsx](apps/web/src/App.tsx) then $frontend-design",
        skills,
      }),
    ).toEqual({
      ok: true,
      inputs: [
        { type: "mention", name: "App.tsx", path: "apps/web/src/App.tsx" },
        {
          type: "skill",
          name: "frontend-design",
          path: "/skills/frontend-design/SKILL.md",
        },
      ],
    });
  });

  it("surfaces unresolved skill and invalid mention paths", () => {
    expect(resolveComposerStructuredInputs({ text: "$missing", skills })).toEqual({
      ok: false,
      message: "Skill '$missing' is unavailable for the selected provider.",
    });
    expect(resolveComposerStructuredInputs({ text: "[bad](src/%ZZ.ts)", skills })).toEqual({
      ok: false,
      message: "File mention 'bad' has an invalid encoded path.",
    });
  });
});
