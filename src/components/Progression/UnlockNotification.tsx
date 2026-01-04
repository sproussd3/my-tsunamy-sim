"use client";

import { AnimatePresence, motion } from "framer-motion";

type Props = {
  message: string | null;
  onClose: () => void;
};

export default function UnlockNotification({ message, onClose }: Props) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98 }}
          transition={{ duration: 0.25 }}
          className="fixed bottom-6 right-6 z-30 max-w-sm rounded-2xl bg-white/10 border border-white/15 shadow-panel p-4 backdrop-blur-md"
          role="status"
        >
          <div className="text-sm font-semibold mb-1 text-harmee-accent">Unlock achieved</div>
          <div className="text-sm text-white/80">{message}</div>
          <button
            onClick={onClose}
            className="mt-3 text-xs uppercase tracking-[0.2em] text-white/60 hover:text-white transition"
          >
            Dismiss
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
