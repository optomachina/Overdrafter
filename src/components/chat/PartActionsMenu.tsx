import type { ComponentType, ReactNode } from "react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

type PartActionProjectOption = {
  id: string;
  name: string;
};

export type PartActionsMenuProps = {
  showBatchAction?: boolean;
  isCreateProjectDisabled?: boolean;
  onCreateProject?: () => void;
  onCreateProjectFromSelection?: () => void;
  onEditPart: () => void;
  onRenamePart?: () => void;
  addableProjects: PartActionProjectOption[];
  removableProjects: PartActionProjectOption[];
  singleRemoveLabel?: string;
  isMoveBusy?: boolean;
  onAddToProject?: (projectId: string) => void;
  onRemoveFromProject?: (projectId: string) => void;
  onArchivePart?: () => void;
  isArchiveBusy?: boolean;
  pinLabel: string;
  onTogglePin: () => void;
  isPinBusy?: boolean;
  extraContent?: ReactNode;
};

type PartActionPrimitives = {
  Content: ComponentType<Record<string, unknown>>;
  Item: ComponentType<Record<string, unknown>>;
  Separator: ComponentType<Record<string, unknown>>;
  Sub: ComponentType<Record<string, unknown>>;
  SubContent: ComponentType<Record<string, unknown>>;
  SubTrigger: ComponentType<Record<string, unknown>>;
};

const MENU_CONTENT_CLASS = "workspace-shell w-56 rounded-xl border-white/[0.08] bg-ws-raised p-1 text-white";
const SUBMENU_CONTENT_CLASS =
  "workspace-shell max-h-[280px] w-56 overflow-y-auto rounded-xl border-white/[0.08] bg-ws-raised p-1 text-white";

function renderSharedPartActions(
  primitives: PartActionPrimitives,
  {
    showBatchAction = false,
    isCreateProjectDisabled = false,
    onCreateProject,
    onCreateProjectFromSelection,
    onEditPart,
    onRenamePart,
    addableProjects,
    removableProjects,
    singleRemoveLabel = "Remove from project",
    isMoveBusy = false,
    onAddToProject,
    onRemoveFromProject,
    onArchivePart,
    isArchiveBusy = false,
    pinLabel,
    onTogglePin,
    isPinBusy = false,
    extraContent = null,
  }: PartActionsMenuProps,
  contentProps: Record<string, unknown> = {},
) {
  const { Content, Item, Separator, Sub, SubContent, SubTrigger } = primitives;

  return (
    <Content className={MENU_CONTENT_CLASS} {...contentProps}>
      {showBatchAction ? (
        <Item
          disabled={!onCreateProjectFromSelection || isCreateProjectDisabled}
          onSelect={() => {
            onCreateProjectFromSelection?.();
          }}
        >
          Create new project
        </Item>
      ) : (
        <>
          <Item onSelect={onEditPart}>Edit part</Item>
          {onRenamePart ? <Item onSelect={onRenamePart}>Rename part</Item> : null}

          {onAddToProject ? (
            <Sub>
              <SubTrigger inset>Add to project</SubTrigger>
              <SubContent className={SUBMENU_CONTENT_CLASS}>
                {addableProjects.length === 0 ? (
                  onCreateProject ? (
                    <Item
                      disabled={isCreateProjectDisabled}
                      onSelect={() => {
                        onCreateProject();
                      }}
                    >
                      Create new project
                    </Item>
                  ) : (
                    <Item disabled>No other projects available</Item>
                  )
                ) : (
                  addableProjects.map((project) => (
                    <Item
                      key={project.id}
                      disabled={isMoveBusy}
                      onSelect={() => {
                        onAddToProject(project.id);
                      }}
                    >
                      {project.name}
                    </Item>
                  ))
                )}
              </SubContent>
            </Sub>
          ) : null}

          {onRemoveFromProject && removableProjects.length > 0 ? (
            removableProjects.length === 1 ? (
              <Item
                disabled={isMoveBusy}
                onSelect={() => {
                  onRemoveFromProject(removableProjects[0]!.id);
                }}
              >
                {singleRemoveLabel}
              </Item>
            ) : (
              <Sub>
                <SubTrigger inset>Remove from project</SubTrigger>
                <SubContent className={SUBMENU_CONTENT_CLASS}>
                  {removableProjects.map((project) => (
                    <Item
                      key={project.id}
                      disabled={isMoveBusy}
                      onSelect={() => {
                        onRemoveFromProject(project.id);
                      }}
                    >
                      {project.name}
                    </Item>
                  ))}
                </SubContent>
              </Sub>
            )
          ) : null}

          <Separator />
          {onArchivePart ? (
            <Item
              disabled={isArchiveBusy}
              onSelect={() => {
                onArchivePart();
              }}
            >
              Archive part
            </Item>
          ) : null}
          <Item
            disabled={isPinBusy}
            onSelect={() => {
              onTogglePin();
            }}
          >
            {pinLabel}
          </Item>
          {extraContent ? (
            <>
              <Separator />
              {extraContent}
            </>
          ) : null}
        </>
      )}
    </Content>
  );
}

export function PartContextMenuActions(props: PartActionsMenuProps) {
  return renderSharedPartActions(
    {
      Content: ContextMenuContent,
      Item: ContextMenuItem,
      Separator: ContextMenuSeparator,
      Sub: ContextMenuSub,
      SubContent: ContextMenuSubContent,
      SubTrigger: ContextMenuSubTrigger,
    },
    props,
  );
}

export function PartDropdownMenuActions(
  props: PartActionsMenuProps & {
    align?: "start" | "center" | "end";
    sideOffset?: number;
  },
) {
  const { align = "end", sideOffset = 8, ...menuProps } = props;

  return renderSharedPartActions(
    {
      Content: DropdownMenuContent,
      Item: DropdownMenuItem,
      Separator: DropdownMenuSeparator,
      Sub: DropdownMenuSub,
      SubContent: DropdownMenuSubContent,
      SubTrigger: DropdownMenuSubTrigger,
    },
    menuProps,
    { align, sideOffset },
  );
}
