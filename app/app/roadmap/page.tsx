import { PHASES, STATUS_LABEL } from '@/lib/roadmap';

export const metadata = {
  title: 'Roadmap, Probatio',
  description:
    'Where Probatio goes after launch. A competitive arena, more markets to trade, and a proven record that earns real capital.',
};

/**
 * Where this goes after launch.
 *
 * Not a launch checklist. Launch is the start line, not the finish, and this is
 * the argument for following the thing past it. The record you build here is
 * meant to become worth something, and the ground under it keeps widening. Each
 * phase is marked with how real it is, because a roadmap that dresses a wish up
 * as a commitment is the dishonesty the rest of the site exists to avoid.
 */

export default function RoadmapPage() {
  return (
    <main className="roadmap">
      <div className="page-head">
        <h1>Roadmap</h1>
        <p className="dim">
          The honest simulator, records committed to Solana, ranked seasons and the coach were
          here at launch. This page is everything after: what the record lets us build next, and
          where being good enough eventually pays. Phase one is finished, and a phase is only
          marked shipped when every item in it is live and you can go and use it. Each of the
          rest is marked with how real it is, because a wish painted as a promise is the one
          thing this site exists not to do.
        </p>
      </div>

      <ol className="phases">
        {PHASES.map((phase) => (
          <li key={phase.tag} className="phase">
            <div className="phase-rail" aria-hidden="true">
              <span className="phase-tag">{phase.tag}</span>
            </div>
            <div className="phase-body">
              <div className="phase-head">
                <h2>{phase.name}</h2>
                <span className={`phase-status s-${phase.status}`}>{STATUS_LABEL[phase.status]}</span>
              </div>
              <p className="dim phase-summary">{phase.summary}</p>
              <ul className="phase-items">
                {phase.items.map((item) => (
                  <li key={item.title}>
                    <span className="phase-item-title">{item.title}</span>
                    <span className="phase-item-detail dim">{item.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>

      <p className="dim roadmap-foot">
        Written to be honest about what is real. <em>Shipped</em> means every item in that phase
        is live on this site today; <em>exploring</em> is a direction, not a promise. See <a href="/trust">what you have to trust</a> for the rest of that
        argument.
      </p>
    </main>
  );
}
