"use client";

import { selectProgress, useGameStore } from "../../../store/gameStore";

export default function ProgressBar() {
  const { next, ratio } = useGameStore(selectProgress);
  const totalHits = useGameStore((s) => s.totalHits);
  return (
    <div className="w-full max-w-md">
      <div className="flex justify-between text-xs text-white/60 mb-1">
        <span>Total: {totalHits}</span>
        <span>{next ? `Next unlock @ ${next}` : "All milestones cleared"}</span>
      </div>
      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-harmee-accent to-white"
          style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
        />
      </div>
    </div>
  );
}
