import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerSecretUserInput } from "./ComposerSecretUserInput";

describe("ComposerSecretUserInput", () => {
  it("masks Codex secret answers and disables browser credential completion", () => {
    const html = renderToStaticMarkup(
      <ComposerSecretUserInput
        label="API key"
        value="top-secret"
        disabled={false}
        mobileActions={false}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('name="codex-secret-response"');
    expect(html).toContain('aria-label="API key"');
    expect(html).not.toContain('type="text"');
  });
});
