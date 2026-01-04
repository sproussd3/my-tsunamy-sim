export type Mood = "idle" | "warmup" | "charged" | "furious" | "boss";

export type MoodState = {
  mood: Mood;
  boss: boolean;
  tint: string;
  label: string;
};

export function moodFromCombo(combo: number): MoodState {
  if (combo >= 13) {
    return { mood: "boss", boss: true, tint: "rgba(255,0,76,0.16)", label: "Boss" };
  }
  if (combo >= 10) {
    return { mood: "furious", boss: false, tint: "rgba(255,120,0,0.12)", label: "Furious" };
  }
  if (combo >= 6) {
    return { mood: "charged", boss: false, tint: "rgba(0,208,255,0.1)", label: "Charged" };
  }
  if (combo >= 3) {
    return { mood: "warmup", boss: false, tint: "rgba(0,255,170,0.08)", label: "Warmup" };
  }
  return { mood: "idle", boss: false, tint: "transparent", label: "Idle" };
}
