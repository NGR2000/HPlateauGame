// GameTarget の回収・地上風報告ルール。距離は水平距離(m)、速度はm/s。
export const RECOVERY_RADIUS = 30;

export function groundReportStatus({ active, reported, distance, speedMps }) {
  if (reported) return 'reported';
  if (!active) return 'inactive';
  if (!Number.isFinite(distance) || distance < 100) return 'too-close';
  if (distance > 400) return 'too-far';
  if (!Number.isFinite(speedMps) || Math.abs(speedMps) > 0.05) return 'moving';
  return 'ready';
}

export function chasePoints({ caught = false, afterLanding = false, reported = false }) {
  const recovery = caught ? (afterLanding ? 500 : 1000) : 0;
  const report = reported ? 50 : 0;
  return { recovery, report, total: recovery + report };
}
