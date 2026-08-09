import type { ValidationReport } from './replay';

/**
 * A human-readable summary.
 *
 * The docs at step M46 publish the sim's measured accuracy, and this is where
 * that number comes from. Anyone should be able to run the harness and get the
 * same figure.
 */
export function formatReport(report: ValidationReport): string {
  const lines = [
    `mint            ${report.mint}`,
    `engine version  ${report.engineVersion}`,
    `events seen     ${report.eventsSeen}`,
    `samples         ${report.samples}  (${report.buys} buys, ${report.sells} sells)`,
    `skipped         ${report.skipped.not_consecutive} not consecutive, ` +
      `${report.skipped.unquotable} unquotable, ${report.skipped.first_event} first`,
    `median error    ${report.medianErrorBps} bps`,
    `p95 error       ${report.p95ErrorBps} bps`,
    `max error       ${report.maxErrorBps} bps`,
    `exact matches   ${report.exactMatches}/${report.samples} ` +
      `(${(report.exactRate * 100).toFixed(2)}%)`,
  ];

  if (report.worst.length > 0 && report.maxErrorBps > 0) {
    lines.push('worst cases');
    for (const sample of report.worst) {
      lines.push(
        `  ${sample.side.padEnd(4)} slot ${sample.slot}  ${sample.errorBps}bps  ` +
          `expected ${sample.expected} got ${sample.actual}`,
      );
    }
  }

  return lines.join('\n');
}
