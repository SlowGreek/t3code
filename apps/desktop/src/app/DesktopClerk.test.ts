import { assert, describe, it } from "@effect/vitest";

import * as DesktopClerk from "./DesktopClerk.ts";

describe("DesktopClerk", () => {
  it("permanently excludes Clerk hosts from the desktop CSP", () => {
    const publishableKey = `pk_test_${btoa("clerk.t3.codes$")}`;

    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname(publishableKey), undefined);
    assert.equal(DesktopClerk.desktopClerkFrontendApiHostname, undefined);
  });
});
