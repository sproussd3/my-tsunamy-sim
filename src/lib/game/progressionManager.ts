export const MILESTONES = [50, 200, 500, 1000, 2500];

export function nextMilestone(total: number): number | null {
  for (const m of MILESTONES) {
    if (total < m) return m;
  }
  return null;
}

export function previousMilestone(total: number): number {
  let prev = 0;
  for (const m of MILESTONES) {
    if (total >= m) prev = m;
  }
  return prev;
}

export function progressToNext(total: number): { next: number | null; ratio: number } {
  const next = nextMilestone(total);
  if (next === null) return { next: null, ratio: 1 };
  const prev = previousMilestone(total);
  const span = next - prev || 1;
  const ratio = Math.min(1, Math.max(0, (total - prev) / span));
  return { next, ratio };
}

export function findNewUnlock(total: number, unlocked: number[]): number | null {
  const unlockedSet = new Set(unlocked);
  for (const m of MILESTONES) {
    if (total >= m && !unlockedSet.has(m)) return m;
  }
  return null;
}
