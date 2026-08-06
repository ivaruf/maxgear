// Campaign structure: 4 short levels + difficulty presets. LEAD-OWNED.
// Pure data (leaf module — no imports). See scratchpad campaign-spec for flow.

export const DIFFICULTIES = {
  easy: { key: 'easy', label: 'EASY', enemyHp: 0.75, enemyDmg: 0.75, density: 0.9, bossSec: 20 },
  medium: { key: 'medium', label: 'MEDIUM', enemyHp: 1, enemyDmg: 1, density: 1, bossSec: 24 },
  hard: { key: 'hard', label: 'HARD', enemyHp: 1.3, enemyDmg: 1.2, density: 1.15, bossSec: 28 },
};

// length = pre-end-fight travel in world units (250 u/s -> ~56-68s of driving).
// tier gates which upgrade tracks may appear (upgrades.js ENTRIES[key].tier).
export const LEVELS = [
  {
    id: 1, name: 'THE OUTSKIRTS', length: 14000, tier: 1, end: 'foreman',
    enemyPool: ['grunt', 'runner', 'shooter'], gateRows: 5, skyShift: 0,
  },
  {
    id: 2, name: 'THE FOUNDRY', length: 15000, tier: 2, end: 'foreman',
    enemyPool: ['grunt', 'runner', 'shooter', 'splitter', 'mini', 'tank'],
    gateRows: 6, skyShift: -12,
  },
  {
    id: 3, name: 'THE SHIPYARDS', length: 16000, tier: 3, end: 'foreman',
    enemyPool: ['grunt', 'runner', 'shooter', 'splitter', 'mini', 'tank',
      'charger', 'shield', 'bomber', 'welder', 'turret'],
    gateRows: 6, skyShift: 14,
  },
  {
    id: 4, name: 'THE IRONWORKS', length: 17000, tier: 3, end: 'ironclad',
    enemyPool: 'all', gateRows: 7, skyShift: 26,
  },
];

export const levelDef = (i) => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i | 0))];
export const isFinalLevel = (i) => i >= LEVELS.length - 1;
