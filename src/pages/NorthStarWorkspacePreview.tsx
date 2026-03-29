const NorthStarWorkspacePreview = () => {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">North Star preview</p>
      <h1 className="text-2xl font-semibold tracking-tight">North Star workspace is enabled</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">
        This preview route is intentionally isolated behind the dual-gate rollout contract while classic workspace remains
        the production default.
      </p>
    </main>
  );
};

export default NorthStarWorkspacePreview;
