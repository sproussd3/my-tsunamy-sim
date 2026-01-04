"use client";

import { motion } from "framer-motion";
import { useGameStore } from "../../../store/gameStore";

export default function MoodIndicator() {
  const { mood } = useGameStore((s) => ({ mood: s.mood }));
  return (
    <motion.div
      key={mood.mood}
      initial={{ opacity: 0.4, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 shadow-panel"
    >
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-harmee-accent" />
      <div className="text-sm font-semibold tracking-tight">{mood.label}</div>
      <div className="text-xs uppercase tracking-[0.2em] text-white/50">Mood</div>
    </motion.div>
  );
}
