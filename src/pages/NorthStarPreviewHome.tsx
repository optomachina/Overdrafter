const NorthStarPreviewHome = () => {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen max-w-4xl flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">North Star Preview</p>
        <h1 className="text-3xl font-semibold">Workspace shell preview</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          This preview remains behind the dual-gate rollout guardrail while classic UI stays the default.
        </p>
      </section>
    </main>
  );
};

export default NorthStarPreviewHome;
