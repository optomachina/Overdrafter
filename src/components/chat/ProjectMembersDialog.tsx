import { useMemo, useState } from "react";
import { Copy, Loader2, UserPlus, Users } from "lucide-react";
import type { ProjectInviteSummary, ProjectMembershipRecord, ProjectRole } from "@/features/quotes/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type ProjectMembersDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUserId: string;
  memberships: ProjectMembershipRecord[];
  invites: ProjectInviteSummary[];
  canManage: boolean;
  onInvite: (email: string, role: ProjectRole) => Promise<void>;
  onRemoveMembership: (membershipId: string) => Promise<void>;
};

export function ProjectMembersDialog({
  open,
  onOpenChange,
  currentUserId,
  memberships,
  invites,
  canManage,
  onInvite,
  onRemoveMembership,
}: ProjectMembersDialogProps) {
  const [email, setEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [removingMembershipId, setRemovingMembershipId] = useState<string | null>(null);
  const baseUrl = useMemo(() => window.location.origin, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-ws-overlay text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Project members
          </DialogTitle>
          <DialogDescription className="text-white/55">
            Invite editors by email and share the generated link directly.
          </DialogDescription>
        </DialogHeader>

        {canManage ? (
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
            <div className="flex gap-2">
              <Input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                className="border-white/10 bg-ws-raised text-white placeholder:text-white/35"
              />
              <Button
                className="rounded-full"
                disabled={isInviting || email.trim().length === 0}
                onClick={async () => {
                  setIsInviting(true);

                  try {
                    await onInvite(email, "editor");
                    setEmail("");
                  } finally {
                    setIsInviting(false);
                  }
                }}
              >
                {isInviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="space-y-3">
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-white/40">Members</p>
            <div className="space-y-2">
              {memberships.map((membership) => (
                <div
                  key={membership.id}
                  className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-white">
                      {membership.user_id === currentUserId ? "You" : `Member ${membership.user_id.slice(0, 8)}`}
                    </p>
                    <p className="text-xs uppercase tracking-[0.18em] text-white/40">{membership.role}</p>
                  </div>

                  {canManage && membership.role !== "owner" ? (
                    <Button
                      variant="ghost"
                      className="rounded-full text-white/60 hover:bg-white/6 hover:text-white"
                      disabled={removingMembershipId === membership.id}
                      onClick={async () => {
                        setRemovingMembershipId(membership.id);

                        try {
                          await onRemoveMembership(membership.id);
                        } finally {
                          setRemovingMembershipId(null);
                        }
                      }}
                    >
                      {removingMembershipId === membership.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Remove"
                      )}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-white/40">Pending invites</p>
            <div className="space-y-2">
              {invites.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/8 bg-black/20 px-4 py-6 text-sm text-white/45">
                  No invites yet.
                </div>
              ) : (
                invites.map((invite) => {
                  const inviteLink = `${baseUrl}/shared/${invite.token}`;

                  return (
                    <div
                      key={invite.id}
                      className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">{invite.email}</p>
                          <p className="text-xs uppercase tracking-[0.18em] text-white/40">{invite.status}</p>
                        </div>
                        <Button
                          variant="ghost"
                          className="rounded-full text-white/60 hover:bg-white/6 hover:text-white"
                          onClick={() => {
                            void navigator.clipboard.writeText(inviteLink);
                          }}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          Copy link
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
