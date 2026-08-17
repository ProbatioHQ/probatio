/**
 * The ground behind the hero.
 *
 * Nothing is drawn on it. No candles, no ranges, no falling characters, no
 * grid: every one of those was something to look at competing with the only
 * thing on the screen worth reading, and each was busier than the last.
 *
 * What is left is light. Three soft fields of the one colour this site uses,
 * drifting against each other slowly enough that the movement is felt rather
 * than watched, over a dark ground. There is nothing to interpret and nothing
 * with an edge, which is what makes it sit behind a headline instead of
 * arguing with it.
 *
 * No canvas either. This is three gradients and two keyframes, so it costs the
 * compositor a few pixels a frame and the main thread nothing at all, and it
 * stops entirely for anybody who has asked for less motion.
 */
export function HeroBackdrop() {
  return (
    <div className="scene" aria-hidden="true">
      <span className="scene-wash one" />
      <span className="scene-wash two" />
      <span className="scene-wash three" />
    </div>
  );
}
