import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMembersDialog } from "./ProjectMembersDialog";

describe("ProjectMembersDialog", () => {
  const onOpenChange = vi.fn();
  const onInvite = vi.fn();
  const onRemoveMembership = vi.fn();
  const writeText = vi.fn();

  beforeEach(() => {
    onOpenChange.mockReset();
    onInvite.mockReset();
    onRemoveMembership.mockReset();
    writeText.mockReset();
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });
  });

  it("invites editors, removes non-owner members, and copies invite links", async () => {
    onInvite.mockResolvedValue(undefined);
    onRemoveMembership.mockResolvedValue(undefined);
    writeText.mockResolvedValue(undefined);

    render(
      <ProjectMembersDialog
        open
        onOpenChange={onOpenChange}
        currentUserId="user-1"
        canManage
        memberships={[
          { id: "membership-1", project_id: "project-1", user_id: "user-1", role: "owner", created_at: "2026-03-01" },
          { id: "membership-2", project_id: "project-1", user_id: "user-2", role: "editor", created_at: "2026-03-02" },
        ]}
        invites={[
          {
            id: "invite-1",
            project_id: "project-1",
            email: "teammate@example.com",
            role: "editor",
            token: "invite-token",
            status: "pending",
            created_at: "2026-03-03",
            expires_at: null,
            accepted_at: null,
          },
        ]}
        onInvite={onInvite}
        onRemoveMembership={onRemoveMembership}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "newmember@example.com" },
    });
    fireEvent.click(screen.getAllByRole("button")[0]);

    await waitFor(() => {
      expect(onInvite).toHaveBeenCalledWith("newmember@example.com", "editor");
    });
    expect(screen.getByPlaceholderText("name@example.com")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() => {
      expect(onRemoveMembership).toHaveBeenCalledWith("membership-2");
    });

    fireEvent.click(screen.getByRole("button", { name: /copy link/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/shared/invite-token`);
    });
  });
});
