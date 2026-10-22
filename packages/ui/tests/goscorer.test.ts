/**
 * Scoring against the vendored goscorer module.
 * Boards use X = black, O = white, . = empty. Coordinates are x,y.
 */

import { describe, expect, test } from 'bun:test';
import type { Sign, SignMap } from '@kaya/goboard';
import {
  calculateScore,
  defaultKomiForRules,
  scoreTotals,
  scoringMethodForRules,
  sgfRulesValue,
  suggestDeadStones,
} from '../src/services/scoring';
import type { ScoreCounts } from '../src/services/scoring';

function board(rows: string[]): SignMap {
  return rows.map(row => [...row].map(ch => (ch === 'X' ? 1 : ch === 'O' ? -1 : 0) as Sign));
}

function counts(
  signMap: SignMap,
  method: 'territory' | 'area',
  dead: Set<string> = new Set()
): ScoreCounts {
  const scored = calculateScore(signMap, dead, method);
  return {
    method,
    blackTerritory: scored.blackTerritory,
    whiteTerritory: scored.whiteTerritory,
    blackStones: scored.blackStones,
    whiteStones: scored.whiteStones,
    blackCaptures: 0,
    whiteCaptures: 0,
    blackDeadStones: 0,
    whiteDeadStones: 0,
    komi: 0,
  };
}

describe('rules', () => {
  test('Japanese is territory with 6.5, Chinese is area with 7.5', () => {
    expect(scoringMethodForRules(undefined)).toBe('territory');
    expect(scoringMethodForRules('Japanese')).toBe('territory');
    expect(scoringMethodForRules('korean')).toBe('territory');
    expect(scoringMethodForRules('Chinese')).toBe('area');
    expect(scoringMethodForRules('中国规则')).toBe('area');
    expect(scoringMethodForRules('中國')).toBe('area');
    expect(scoringMethodForRules('AGA')).toBe('area');
    expect(scoringMethodForRules('Ing')).toBe('area');
    expect(defaultKomiForRules('japanese')).toBe(6.5);
    expect(defaultKomiForRules('chinese')).toBe(7.5);
    expect(sgfRulesValue('japanese')).toBe('Japanese');
    expect(sgfRulesValue('chinese')).toBe('Chinese');
    expect(sgfRulesValue(undefined)).toBe('Japanese');
  });
});

describe('goscorer positions', () => {
  test('a false eye is not Japanese territory and is a Chinese point', () => {
    const signMap = board(['.X..O', 'OXXO.', '.OOO.', '.O.O.', '.....']);
    const territory = counts(signMap, 'territory');
    const area = counts(signMap, 'area');

    expect(territory.blackTerritory).toBe(0);
    expect(territory.whiteTerritory).toBe(10);
    expect(area.blackStones).toBe(3);
    expect(area.whiteStones).toBe(8);
    expect(area.whiteTerritory).toBe(11);
    expect(calculateScore(signMap, new Set(), 'territory').territories[2][0]).toBe(0);
  });

  test('seki has no territory, and an estimate does not fill the shared liberties', () => {
    const signMap = board(['XXXXXXX', 'X.O.O.X', 'X.O.O.X', 'XXXXXXX']);
    const territory = counts(signMap, 'territory');
    const area = counts(signMap, 'area');

    expect(territory.blackTerritory).toBe(0);
    expect(territory.whiteTerritory).toBe(0);
    expect(area.blackStones).toBe(18);
    expect(area.whiteStones).toBe(4);
    expect(area.blackTerritory).toBe(0);
    expect(area.whiteTerritory).toBe(0);

    const hostile = signMap.map(row => row.map(() => 1));
    expect(suggestDeadStones(signMap, hostile).size).toBe(0);
  });

  test('marked dead stones become territory, and area does not count them as stones', () => {
    const signMap = board(['OOOOO', 'OXXXO', 'OX.XO', 'OXXXO', 'OOOOO']);
    const dead = new Set(['1,1', '2,1', '3,1', '1,2', '3,2', '1,3', '2,3', '3,3']);
    const territory = counts(signMap, 'territory', dead);
    const area = counts(signMap, 'area', dead);

    expect(territory.whiteTerritory).toBe(9);
    expect(territory.blackTerritory).toBe(0);
    expect(area.whiteStones).toBe(16);
    expect(area.blackStones).toBe(0);
    expect(area.whiteTerritory).toBe(9);

    const totals = scoreTotals({
      ...area,
      blackCaptures: 4,
      whiteCaptures: 2,
      komi: 7.5,
    });
    expect(totals.white).toBe(16 + 9 + 7.5);
    expect(totals.black).toBe(0);
  });

  test('dame stays empty, including a group Monte Carlo would call dead', () => {
    const signMap = board([
      '...XXOOXXXX..',
      '...XOO.O.OXX.',
      '...XO.O.OOOOX',
      '...XXOO.X.OX.',
      '.XXXOOXXXXXXX',
      'X..XOOOOOO.X.',
      '.XXOOXOO.OOOX',
      '...XXXXXOOXOO',
      '......XXXOXXO',
      '.XXX.X..XXXXX',
      'X..X..XXOOOOX',
      '.XXOO.XOO..OO',
      '......XXXOO..',
    ]);
    const prob = signMap.map(row => row.map(() => 0));
    // D2 and E2. Monte Carlo can call both hostile; they only share dame.
    prob[11][3] = 1;
    prob[11][4] = 1;
    expect(suggestDeadStones(signMap, prob).size).toBe(0);

    const scored = calculateScore(signMap, new Set(), 'territory');
    // C1, F1, E4, F3 are black-side dame; H11 is white-side dame.
    expect(scored.territories[12][2]).toBe(0);
    expect(scored.territories[12][5]).toBe(0);
    expect(scored.territories[9][4]).toBe(0);
    expect(scored.territories[10][5]).toBe(0);
    expect(scored.territories[2][7]).toBe(0);
    expect(scored.blackTerritory).toBe(19);
    expect(scored.whiteTerritory).toBe(7);
  });

  test('stones enclosed with no dame liberty are still marked dead', () => {
    const signMap = board(['OOOOO', 'OXXXO', 'OX.XO', 'OXXXO', 'OOOOO']);
    const prob = signMap.map(row => row.map(sign => (sign === 1 ? -1 : 0)));
    const dead = suggestDeadStones(signMap, prob);
    expect([...dead].sort()).toEqual(
      ['1,1', '1,2', '1,3', '2,1', '2,3', '3,1', '3,2', '3,3'].sort()
    );
    expect(calculateScore(signMap, dead, 'territory').whiteTerritory).toBe(9);
  });
});
