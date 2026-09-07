export default function StatusNotFound() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>
          Status page not found
        </h1>
        <p className="mt-1.5 text-sm" style={{ color: 'var(--ink-subtle)' }}>
          This status page does not exist, or its project has been deleted.
        </p>
      </div>
    </main>
  );
}
