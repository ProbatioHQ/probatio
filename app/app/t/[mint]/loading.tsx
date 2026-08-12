/**
 * Shown while a token page reads its metadata and chart history on the server.
 *
 * Without a loading file the page-transition animation leaves the content area
 * at zero opacity for the whole server render, which on a cold token can be
 * several seconds of an apparently hung page. React swaps to this the instant
 * the navigation commits, so there is always something on screen.
 */
export default function Loading() {
  return (
    <section className="term" aria-busy="true" aria-label="Loading token">
      <div className="term-bar">
        <span className="prompt">~/token</span>
        <span className="dim">reading from the chain…</span>
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="term-body">
        <div className="skeleton" style={{ height: 28, width: '40%' }} />
        <div className="skeleton" style={{ height: 16, width: '60%', marginTop: 12 }} />
        <div className="skeleton" style={{ height: 320, width: '100%', marginTop: 20 }} />
      </div>
    </section>
  );
}
