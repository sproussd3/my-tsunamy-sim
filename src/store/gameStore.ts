'use client';

import { create } from "zustand";
import { moodFromCombo, MoodState } from "../lib/game/moodEngine";
import { findNewUnlock, progressToNext } from "../lib/game/progressionManager";
import { readJSON, writeJSON } from "../lib/utils/localStorage";

type Persisted = {
  totalHits: number;
  unlocked: number[];
  muted: boolean;
  reduced: boolean;
};

type GameState = {
  combo: number;
  totalHits: number;
  mood: MoodState;
  unlocked: number[];
  toast: string | null;
  muted: boolean;
  reduced: boolean;
  hydrated: boolean;
  hit: () => void;
  resetCombo: () => void;
  toggleMute: () => void;
  toggleReduced: () => void;
  clearToast: () => void;
  hydrate: () => void;
};

const STORAGE_KEY = "harmee_progress";

export const useGameStore = create<GameState>((set, get) => ({
  combo: 0,
  totalHits: 0,
  mood: moodFromCombo(0),
  unlocked: [],
  toast: null,
  muted: false,
  reduced: false,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    const data = readJSON<Persisted>(STORAGE_KEY, {
      totalHits: 0,
      unlocked: [],
      muted: false,
      reduced: false
    });
    set({
      totalHits: data.totalHits,
      unlocked: data.unlocked,
      muted: data.muted,
      reduced: data.reduced,
      hydrated: true
    });
  },

  hit: () => {
    const combo = get().combo + 1;
    const totalHits = get().totalHits + 1;
    const mood = moodFromCombo(combo);

    const newUnlock = findNewUnlock(totalHits, get().unlocked);
    const unlocked = newUnlock ? [...get().unlocked, newUnlock] : get().unlocked;
    const toast = newUnlock ? `Hit milestone ${newUnlock}!` : get().toast;

    set({ combo, totalHits, mood, unlocked, toast });

    writeJSON<Persisted>(STORAGE_KEY, {
      totalHits,
      unlocked,
      muted: get().muted,
      reduced: get().reduced
    });
  },

  resetCombo: () => set({ combo: 0, mood: moodFromCombo(0) }),

  toggleMute: () => {
    const muted = !get().muted;
    set({ muted });
    writeJSON<Persisted>(STORAGE_KEY, {
      totalHits: get().totalHits,
      unlocked: get().unlocked,
      muted,
      reduced: get().reduced
    });
  },

  toggleReduced: () => {
    const reduced = !get().reduced;
    set({ reduced });
    writeJSON<Persisted>(STORAGE_KEY, {
      totalHits: get().totalHits,
      unlocked: get().unlocked,
      muted: get().muted,
      reduced
    });
  },

  clearToast: () => set({ toast: null })
}));

export const selectProgress = (state: GameState) => progressToNext(state.totalHits);
