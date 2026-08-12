/**
 * Shown while a public record page loads its account and history on the server,
 * so the page-transition does not leave the content area blank for the render.
 */
export default function Loading() {
  return (
    <section className="term" aria-busy="true" aria-label="Loading public record">
      <div className="term-bar">
        <span className="prompt">~/record</span>
        <span className="dim">reading the record…</span>
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="term-body">
        <div className="skeleton" style={{ height: 28, width: '45%' }} />
        <div className="skeleton" style={{ height: 16, width: '55%' }} />
        <div className="skeleton" style={{ height: 220, width: '100%' }} />
      </div>
    </section>
  );
}
