// Campaign structure: 4 short levels + difficulty presets. LEAD-OWNED.
// Pure data. Its one import is i18n.js, a leaf itself, for the words: `label`
// and `name` are getters so a language switch from the menu reaches a level
// name or a difficulty already on screen (v1.10).

import { t } from './i18n.js';

export const DIFFICULTIES = {
  easy: { key: 'easy', get label() { return t('diff.easy'); }, enemyHp: 0.75, enemyDmg: 0.75, density: 0.9, bossSec: 20 },
  medium: { key: 'medium', get label() { return t('diff.medium'); }, enemyHp: 1, enemyDmg: 1, density: 1, bossSec: 24 },
  hard: { key: 'hard', get label() { return t('diff.hard'); }, enemyHp: 1.3, enemyDmg: 1.2, density: 1.15, bossSec: 28 },
};

// length = pre-end-fight travel in world units (250 u/s -> ~56-68s of driving).
// tier gates which upgrade tracks may appear (upgrades.js ENTRIES[key].tier).
export const LEVELS = [
  {
    id: 1, get name() { return t('level.1'); }, length: 14000, tier: 1, end: 'foreman',
    enemyPool: ['grunt', 'runner', 'shooter'], gateRows: 5, skyShift: 0,
  },
  {
    id: 2, get name() { return t('level.2'); }, length: 15000, tier: 2, end: 'foreman',
    enemyPool: ['grunt', 'runner', 'shooter', 'splitter', 'mini', 'tank'],
    gateRows: 6, skyShift: -12,
  },
  {
    id: 3, get name() { return t('level.3'); }, length: 16000, tier: 3, end: 'foreman',
    enemyPool: ['grunt', 'runner', 'shooter', 'splitter', 'mini', 'tank',
      'charger', 'shield', 'bomber', 'welder', 'turret'],
    gateRows: 6, skyShift: 14,
  },
  {
    id: 4, get name() { return t('level.4'); }, length: 17000, tier: 3, end: 'ironclad',
    enemyPool: 'all', gateRows: 7, skyShift: 26,
  },
];

export const levelDef = (i) => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i | 0))];
export const isFinalLevel = (i) => i >= LEVELS.length - 1;
