import { useState, useCallback, useEffect, useMemo } from 'react';
import { type Vertex, type GoBoard } from '@kaya/goboard';
import { getProbabilityMap } from '@kaya/deadstones';
import {
  calculateScore,
  countDeadStones,
  scoringMethodForRules,
  suggestDeadStones,
} from '../../services/scoring';
import { type GameInfo, type ScoreData, type ScoringMethod } from '../../types/game';
import { DEFAULT_KOMI } from '@kaya/ai-engine';

interface UseScoringProps {
  currentBoard: GoBoard | null;
  gameInfo: GameInfo;
}

const INITIAL_ITERATIONS = 2000;

function computeScoreData(
  currentBoard: GoBoard,
  deadStones: Set<string>,
  komi: number,
  method: ScoringMethod
): { scoreData: ScoreData; territories: number[][] } {
  const scored = calculateScore(currentBoard.signMap, deadStones, method);
  const { blackDeadStones, whiteDeadStones } = countDeadStones(currentBoard.signMap, deadStones);

  return {
    scoreData: {
      method: scored.method,
      blackTerritory: scored.blackTerritory,
      whiteTerritory: scored.whiteTerritory,
      blackStones: scored.blackStones,
      whiteStones: scored.whiteStones,
      blackCaptures: currentBoard.getCaptures(1),
      whiteCaptures: currentBoard.getCaptures(-1),
      blackDeadStones,
      whiteDeadStones,
      komi,
    },
    territories: scored.territories,
  };
}

export function useScoring({ currentBoard, gameInfo }: UseScoringProps) {
  const [scoreMode, setScoreMode] = useState(false);
  const [deadStones, setDeadStones] = useState<Set<string>>(new Set());
  const [isEstimating, setIsEstimating] = useState(false);
  const [estimationMode, setEstimationMode] = useState(true);
  // null follows gameInfo.rules. A panel toggle pins the method until score mode closes.
  const [methodOverride, setMethodOverride] = useState<ScoringMethod | null>(null);

  const komi = gameInfo.komi ?? DEFAULT_KOMI;
  const scoringMethod = methodOverride ?? scoringMethodForRules(gameInfo.rules);

  // Derive territory map and score data from deadStones (always in sync)
  const { territoryMap, scoreData } = useMemo(() => {
    if (!scoreMode || !currentBoard) {
      return { territoryMap: null, scoreData: null };
    }
    const result = computeScoreData(currentBoard, deadStones, komi, scoringMethod);
    return { territoryMap: result.territories, scoreData: result.scoreData };
  }, [scoreMode, currentBoard, deadStones, komi, scoringMethod]);

  const setScoringMethod = useCallback((method: ScoringMethod) => {
    setMethodOverride(method);
  }, []);

  // Monte Carlo only suggests dead stones. Territory itself comes from goscorer,
  // so dame is not repainted when the probability map is confident.
  const autoScore = useCallback(async () => {
    if (!currentBoard) return;

    try {
      setIsEstimating(true);
      const initialProbMap = await getProbabilityMap(currentBoard.signMap, INITIAL_ITERATIONS);
      setDeadStones(suggestDeadStones(currentBoard.signMap, initialProbMap));
    } catch (error) {
      console.error('Auto-score failed:', error);
    } finally {
      setIsEstimating(false);
    }
  }, [currentBoard]);

  const toggleEstimationMode = useCallback(() => {
    setEstimationMode(prev => !prev);
  }, []);

  // Auto-score when entering score mode
  useEffect(() => {
    if (scoreMode) {
      autoScore();
    } else {
      setDeadStones(new Set());
      setEstimationMode(true);
      setMethodOverride(null);
    }
  }, [scoreMode, autoScore]);

  // Set dead state for vertices. Uses functional updater to avoid stale closures.
  // targetDead: true = mark as dead, false = mark as alive, undefined = toggle based on first vertex
  const toggleDeadStone = useCallback(
    (vertexOrVertices: Vertex | Vertex[], targetDead?: boolean) => {
      const vertices = (
        Array.isArray(vertexOrVertices[0]) ? vertexOrVertices : [vertexOrVertices]
      ) as Vertex[];

      setDeadStones(prev => {
        // Resolve target: explicit param, or toggle based on first vertex
        const shouldBeDead =
          targetDead ?? (vertices[0] ? !prev.has(`${vertices[0][0]},${vertices[0][1]}`) : true);

        const newSet = new Set(prev);
        for (const vertex of vertices) {
          const key = `${vertex[0]},${vertex[1]}`;
          if (shouldBeDead) newSet.add(key);
          else newSet.delete(key);
        }
        return newSet;
      });
    },
    []
  );

  const resetScore = useCallback(() => {
    setDeadStones(new Set());
  }, []);

  return {
    scoreMode,
    setScoreMode,
    scoreData,
    deadStones,
    toggleDeadStone,
    autoScore,
    resetScore,
    territoryMap,
    isEstimating,
    estimationMode,
    toggleEstimationMode,
    scoringMethod,
    setScoringMethod,
  };
}
