import { describe, expect, it } from "vitest";
import type { User } from "@supabase/supabase-js";
import { getAccountDisplayProfile, getDefaultAccountName, getUserDisplayName } from "./account-profile";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    confirmation_sent_at: null,
    recovery_sent_at: null,
    email_change_sent_at: null,
    new_email: null,
    new_phone: null,
    invited_at: null,
    action_link: null,
    email: "blaine.wilson@example.com",
    phone: "",
    created_at: "2026-03-07T00:00:00.000Z",
    confirmed_at: null,
    email_confirmed_at: null,
    phone_confirmed_at: null,
    last_sign_in_at: null,
    role: "authenticated",
    updated_at: "2026-03-07T00:00:00.000Z",
    identities: [],
    is_anonymous: false,
    factors: null,
    ...overrides,
  } as unknown as User;
}

describe("account-profile", () => {
  it("prefers split first and last name metadata for the visible account name", () => {
    const user = makeUser({
      user_metadata: {
        given_name: "Blaine",
        family_name: "Wilson",
        full_name: "Blaine Q. Wilson",
      },
    });

    expect(getUserDisplayName(user)).toBe("Blaine Wilson");
  });

  it("falls back to identity metadata when split names are not on the top-level user metadata", () => {
    const user = makeUser({
      user_metadata: {},
      identities: [
        {
          id: "identity-1",
          provider: "google",
          identity_data: {
            given_name: "Blaine",
            family_name: "Wilson",
          },
        },
      ],
    });

    expect(getUserDisplayName(user)).toBe("Blaine Wilson");
  });

  it("uses company as the default workspace bootstrap name when available", () => {
    const user = makeUser({
      user_metadata: {
        company: "Wilson Aerospace",
      },
    });

    expect(getDefaultAccountName(user)).toBe("Wilson Aerospace");
  });

  it("falls back to a title-cased email local part and derives initials from it", () => {
    const user = makeUser({
      email: "blaine_wilson@example.com",
      user_metadata: {},
    });

    expect(getUserDisplayName(user)).toBe("Blaine Wilson");
    expect(getAccountDisplayProfile(user)).toEqual({
      displayName: "Blaine Wilson",
      initials: "BW",
    });
  });
});
