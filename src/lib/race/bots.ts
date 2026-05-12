export type BotConfig = {
  id: string;
  name: string;
  paceSecPerKm: number;
};

export const DEFAULT_BOTS: BotConfig[] = [
  {
    id: "bot_630",
    name: "Easy Bot",
    paceSecPerKm: 390,
  },
  {
    id: "bot_600",
    name: "Sub-30 5K Bot",
    paceSecPerKm: 360,
  },
  {
    id: "bot_500",
    name: "Sub-25 5K Bot",
    paceSecPerKm: 300,
  },
  {
    id: "bot_400",
    name: "Sub-20 5K Bot",
    paceSecPerKm: 240,
  },
  {
    id: "bot_elite",
    name: "Elite Bot",
    paceSecPerKm: 190,
  },
];