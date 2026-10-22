import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
const REFRESH_ITERATIONS = 1000;
const REFRESH_DEBOUNCE_MS = 300;

/** Create a signMap copy with dead stones replaced by empty (0) */
function buildSignMapWithoutDead(signMap: number[][], deadStones: Set<string>): number[][] {
  const modified = signMap.map(row => [...row]);
  deadStones.forEach(key => {
    const [x, y] = key.split(',').map(Number);
    if (modified[y]?.[x] !== undefined) modified[y][x] = 0;
  });
  return modified;
}

function computeScoreData(
  currentBoard: GoBoard,
  deadStones: Set<string>,
  komi: number,
  method: ScoringMethod,
  probabilityMap: number[][] | null
): { scoreData: ScoreData; territories: number[][] } {
  const scored = calculateScore(currentBoard.signMap, deadStones, method, probabilityMap);
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
  const [probabilityMap, setProbabilityMap] = useState<number[][] | null>(null);
  // null follows gameInfo.rules. A panel toggle pins the method until score mode closes.
  const [methodOverride, setMethodOverride] = useState<ScoringMethod | null>(null);

  const komi = gameInfo.komi ?? DEFAULT_KOMI;
  const scoringMethod = methodOverride ?? scoringMethodForRules(gameInfo.rules);

  // Derive territory map and score data from deadStones (always in sync)
  const { territoryMap, scoreData } = useMemo(() => {
    if (!scoreMode || !currentBoard) {
      return { territoryMap: null, scoreData: null };
    }
    const result = computeScoreData(
      currentBoard,
      deadStones,
      komi,
      scoringMethod,
      estimationMode ? probabilityMap : null
    );
    return { territoryMap: result.territories, scoreData: result.scoreData };
  }, [scoreMode, currentBoard, deadStones, komi, scoringMethod, estimationMode, probabilityMap]);

  const setScoringMethod = useCallback((method: ScoringMethod) => {
    setMethodOverride(method);
  }, []);

  // Compute probability map and derive dead stones from it
  const isAutoScoreRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const autoScore = useCallback(async () => {
    if (!currentBoard) return;

    try {
      setIsEstimating(true);

      // Pass 1: detect dead stones from the original board
      const initialProbMap = await getProbabilityMap(currentBoard.signMap, INITIAL_ITERATIONS);
      const dead = suggestDeadStones(currentBoard.signMap, initialProbMap);

      // Pass 2: recompute prob map with dead stones removed for accurate territory
      let finalProbMap = initialProbMap;
      if (dead.size > 0) {
        const modifiedSignMap = buildSignMapWithoutDead(currentBoard.signMap, dead);
        finalProbMap = await getProbabilityMap(modifiedSignMap, REFRESH_ITERATIONS);
      }

      setProbabilityMap(finalProbMap);
      // Flag so the deadStones effect doesn't re-trigger Monte Carlo
      isAutoScoreRef.current = true;
      setDeadStones(dead);
    } catch (error) {
      console.error('Auto-score failed:', error);
    } finally {
      setIsEstimating(false);
    }
  }, [currentBoard]);

  // Re-run Monte Carlo when dead stones are toggled manually
  useEffect(() => {
    // Skip if not in estimation mode or no board/prob map yet
    if (!scoreMode || !currentBoard || !estimationMode || !probabilityMap) return;

    // Skip the update triggered by autoScore's own setDeadStones
    if (isAutoScoreRef.current) {
      isAutoScoreRef.current = false;
      return;
    }

    // Debounce: wait a bit in case the user toggles multiple stones quickly
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(async () => {
      try {
        setIsEstimating(true);
        const modifiedSignMap = buildSignMapWithoutDead(currentBoard.signMap, deadStones);
        const probMap = await getProbabilityMap(modifiedSignMap, REFRESH_ITERATIONS);
        setProbabilityMap(probMap);
      } catch (error) {
        console.error('Refresh probability map failed:', error);
      } finally {
        setIsEstimating(false);
      }
    }, REFRESH_DEBOUNCE_MS);

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadStones]);

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
      setProbabilityMap(null);
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
