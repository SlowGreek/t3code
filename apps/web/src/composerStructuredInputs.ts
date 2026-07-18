import type { ProviderStructuredInput, ServerProviderSkill } from "@t3tools/contracts";

export type ComposerStructuredInputResolution =
  | { readonly ok: true; readonly inputs: ReadonlyArray<ProviderStructuredInput> }
  | { readonly ok: false; readonly message: string };

type Candidate =
  | { readonly index: number; readonly type: "skill"; readonly name: string }
  | {
      readonly index: number;
      readonly type: "mention";
      readonly name: string;
      readonly encodedPath: string;
    };

export function resolveComposerStructuredInputs(input: {
  readonly text: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}): ComposerStructuredInputResolution {
  const candidates: Candidate[] = [];
  const enabledSkills = new Map(
    input.skills.filter((skill) => skill.enabled).map((skill) => [skill.name, skill] as const),
  );

  for (const match of input.text.matchAll(/(?:^|[\s(])\$([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    const name = match[1];
    if (name) candidates.push({ index: match.index, type: "skill", name });
  }
  for (const match of input.text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    const name = match[1]?.trim();
    const encodedPath = match[2]?.trim();
    if (
      name &&
      encodedPath &&
      !encodedPath.startsWith("#") &&
      !/^[A-Za-z][A-Za-z\d+.-]*:/.test(encodedPath)
    ) {
      candidates.push({ index: match.index, type: "mention", name, encodedPath });
    }
  }

  candidates.sort((left, right) => left.index - right.index);
  const resolved: ProviderStructuredInput[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.type === "skill") {
      const skill = enabledSkills.get(candidate.name);
      if (!skill) {
        return {
          ok: false,
          message: `Skill '$${candidate.name}' is unavailable for the selected provider.`,
        };
      }
      const key = `skill:${skill.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        resolved.push({ type: "skill", name: skill.name, path: skill.path });
      }
      continue;
    }

    let path: string;
    try {
      path = decodeURI(candidate.encodedPath);
    } catch (cause) {
      if (cause instanceof URIError) {
        return {
          ok: false,
          message: `File mention '${candidate.name}' has an invalid encoded path.`,
        };
      }
      throw cause;
    }
    const key = `mention:${path}`;
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({ type: "mention", name: candidate.name, path });
    }
  }

  return { ok: true, inputs: resolved };
}
