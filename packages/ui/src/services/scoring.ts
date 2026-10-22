/**
 * Score calculation via vendored goscorer (David J Wu / lightvector, MIT).
 * The module is the original JavaScript, typed by goscorer.d.mts, same as OGS.
 *
 * Territory (Japanese): empty points only. False eyes and seki eyes are not
 * territory. Captures and the opponent's dead stones are added in scoreTotals.
 * Area (Chinese): living stones plus the empty points and dead stones they
 * enclose. Captures are not added again.
 *
 * The board overlay paints territory points only. Living stones stay unpainted
 * so the stone layer remains visible.
 * Estimate mode fills dame from the Monte Carlo map, except seki points and
 * their neighbors — those liberties are shared and must stay neutral.
 */

import type { Sign, SignMap } from '@kaya/goboard';
import type { Ruleset, ScoringMethod } from '../types/game';
import * as goscorer from './goscorer/goscorer.mjs';

/** Probability threshold for filling dame during estimation. */
const TERRITORY_THRESHOLD = 0.2;

/** Probability threshold for dead stone detection (higher = more conservative). */
export const DEAD_STONE_THRESHOLD = 0.4;

export function defaultKomiForRules(rules: Ruleset): number {
  return rules === 'chinese' ? 7.5 : 6.5;
}

/** SGF RU value. Japanese when a new game does not name a ruleset. */
export function sgfRulesValue(rules: Ruleset | undefined): string {
  return rules === 'chinese' ? 'Chinese' : 'Japanese';
}

/**
 * Japanese and Korean score territory. Chinese, AGA, Ing, and New Zealand
 * score area. An unnamed ruleset stays on the Japanese default.
 */
export function scoringMethodForRules(rules: string | undefined): ScoringMethod {
  const text = (rules ?? '').trim().toLowerCase();
  if (
    text.includes('chin') ||
    text.includes('中国') ||
    text.includes('中國') ||
    text.includes('aga') ||
    text.includes('ing') ||
    text === 'nz' ||
    text.includes('new zealand')
  ) {
    return 'area';
  }
  return 'territory';
}

export interface ScoreCounts {
  method: ScoringMethod;
  blackTerritory: number;
  whiteTerritory: number;
  blackStones: number;
  whiteStones: number;
  blackCaptures: number;
  whiteCaptures: number;
  blackDeadStones: number;
  whiteDeadStones: number;
  komi: number;
}

/** Area totals omit captures: those stones are already on the board or in the territory. */
export function scoreTotals(data: ScoreCounts): { black: number; white: number } {
  if (data.method === 'area') {
    return {
      black: data.blackStones + data.blackTerritory,
      white: data.whiteStones + data.whiteTerritory + data.komi,
    };
  }
  return {
    black: data.blackTerritory + data.blackCaptures + data.whiteDeadStones,
    white: data.whiteTerritory + data.whiteCaptures + data.blackDeadStones + data.komi,
  };
}

interface ScoreResult {
  method: ScoringMethod;
  blackTerritory: number;
  whiteTerritory: number;
  blackStones: number;
  whiteStones: number;
  territories: SignMap;
}

function emptyMap(height: number, width: number): SignMap {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => 0 as Sign));
}

function toColorMap(signMap: SignMap): goscorer.color[][] {
  return signMap.map(row =>
    row.map(sign => (sign === 1 ? goscorer.BLACK : sign === -1 ? goscorer.WHITE : goscorer.EMPTY))
  );
}

function toMarkedDead(signMap: SignMap, deadStones: Set<string>): boolean[][] {
  return signMap.map((row, y) => row.map((_, x) => deadStones.has(`${x},${y}`)));
}

function paint(territories: SignMap, x: number, y: number, owner: goscorer.color): Sign {
  if (owner === goscorer.BLACK) {
    territories[y][x] = 1;
    return 1;
  }
  if (owner === goscorer.WHITE) {
    territories[y][x] = -1;
    return -1;
  }
  return 0;
}

/** Seki points and the liberties touching them are not estimate territory. */
function sekiBlocked(scored: goscorer.LocScore[][]): boolean[][] {
  const height = scored.length;
  const width = scored[0]?.length ?? 0;
  const blocked = Array.from({ length: height }, () => Array.from({ length: width }, () => false));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (scored[y][x].belongsToSekiGroup === goscorer.EMPTY) continue;
      blocked[y][x] = true;
      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (ny >= 0 && ny < height && nx >= 0 && nx < width) blocked[ny][nx] = true;
      }
    }
  }
  return blocked;
}

export function calculateScore(
  signMap: SignMap,
  deadStones: Set<string>,
  method: ScoringMethod,
  probabilityMap: number[][] | null
): ScoreResult {
  const height = signMap.length;
  const width = signMap[0]?.length ?? 0;
  const stones = toColorMap(signMap);
  const marked = toMarkedDead(signMap, deadStones);
  const territories = emptyMap(height, width);
  let blackTerritory = 0;
  let whiteTerritory = 0;
  let blackStones = 0;
  let whiteStones = 0;

  // Territory scoring is also the seki map for estimate mode under either ruleset.
  const scored =
    method === 'territory' || probabilityMap
      ? goscorer.territoryScoring(stones, marked, false)
      : null;

  if (method === 'territory' && scored) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const owner = paint(territories, x, y, scored[y][x].isTerritoryFor);
        if (owner === 1) blackTerritory++;
        else if (owner === -1) whiteTerritory++;
      }
    }
  } else {
    const area = goscorer.areaScoring(stones, marked);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sign = signMap[y][x];
        const dead = marked[y][x];
        if (sign === 1 && !dead) {
          blackStones++;
          continue;
        }
        if (sign === -1 && !dead) {
          whiteStones++;
          continue;
        }
        const owner = paint(territories, x, y, area[y][x]);
        if (owner === 1) blackTerritory++;
        else if (owner === -1) whiteTerritory++;
      }
    }
  }

  if (probabilityMap && scored) {
    const blocked = sekiBlocked(scored);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (signMap[y][x] !== 0 || territories[y][x] !== 0 || blocked[y][x]) continue;
        // Goscorer left non-dame empties blank on purpose: false eyes, and points
        // the other color can still reach. Estimate only fills dame.
        if (!scored[y][x].isDame) continue;
        const prob = probabilityMap[y]?.[x] ?? 0;
        if (prob > TERRITORY_THRESHOLD) {
          territories[y][x] = 1;
          blackTerritory++;
        } else if (prob < -TERRITORY_THRESHOLD) {
          territories[y][x] = -1;
          whiteTerritory++;
        }
      }
    }
  }

  return { method, blackTerritory, whiteTerritory, blackStones, whiteStones, territories };
}

/**
 * Territory map for callers that only need the Japanese count.
 * Dead stones are removed before the regions are scored.
 */
export function calculateTerritory(
  signMap: SignMap,
  deadStones: Set<string>
): { blackTerritory: number; whiteTerritory: number; territories: SignMap } {
  const result = calculateScore(signMap, deadStones, 'territory', null);
  return {
    blackTerritory: result.blackTerritory,
    whiteTerritory: result.whiteTerritory,
    territories: result.territories,
  };
}

/**
 * Stones whose ownership is hostile, grouped by chain.
 * A group with fewer than two eyes that still shares a dame liberty is not
 * removed: Monte Carlo fills that liberty and reports the stones dead, while
 * Japanese scoring leaves them. A group inside the opponent has no dame
 * liberty, so it can still be marked dead.
 */
export function suggestDeadStones(signMap: SignMap, probabilityMap: number[][]): Set<string> {
  const height = signMap.length;
  const width = signMap[0]?.length ?? 0;
  const scored = goscorer.territoryScoring(
    toColorMap(signMap),
    toMarkedDead(signMap, new Set()),
    false
  );
  const seen = new Set<string>();
  const dead = new Set<string>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sign = signMap[y][x];
      if (sign === 0 || seen.has(`${x},${y}`)) continue;

      const chain: string[] = [];
      const stack: Array<[number, number]> = [[x, y]];
      let hostile = 0;
      let dameLiberty = false;
      let sekiStone = false;

      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
        if (signMap[cy][cx] !== sign) continue;
        const key = `${cx},${cy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        chain.push(key);
        if (scored[cy][cx].belongsToSekiGroup !== goscorer.EMPTY) sekiStone = true;

        const prob = probabilityMap[cy]?.[cx] ?? 0;
        if (
          (sign === 1 && prob < -DEAD_STONE_THRESHOLD) ||
          (sign === -1 && prob > DEAD_STONE_THRESHOLD)
        ) {
          hostile++;
        }

        const neighbors: Array<[number, number]> = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (ny < 0 || nx < 0 || ny >= height || nx >= width) continue;
          if (signMap[ny][nx] === 0 && scored[ny][nx].isDame) dameLiberty = true;
          stack.push([nx, ny]);
        }
      }

      if (sekiStone && dameLiberty) continue;
      if (hostile * 2 <= chain.length) continue;
      for (const key of chain) dead.add(key);
    }
  }

  return dead;
}

/** Count dead stones by color from the dead stones set. */
export function countDeadStones(
  signMap: SignMap,
  deadStones: Set<string>
): { blackDeadStones: number; whiteDeadStones: number } {
  let blackDeadStones = 0;
  let whiteDeadStones = 0;

  deadStones.forEach(key => {
    const [x, y] = key.split(',').map(Number);
    const sign = signMap[y]?.[x];
    if (sign === 1) blackDeadStones++;
    if (sign === -1) whiteDeadStones++;
  });

  return { blackDeadStones, whiteDeadStones };
}
