import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../../utils/paths.js';
import type { BacktestConfig } from './backtest-engine.js';
import { DEFAULT_BACKTEST_CONFIG } from './backtest-engine.js';
import { DEFAULT_TRAINING_CONFIG } from './xgb-bridge.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrategyConfig {
  backtest: BacktestConfig;
  training: {
    windowSize: number;
    testSize: number;
    stepSize: number;
  };
  intraday: {
    defaultInterval: '1m' | '5m' | '15m' | '30m' | '1h';
  };
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  backtest: DEFAULT_BACKTEST_CONFIG,
  training: DEFAULT_TRAINING_CONFIG,
  intraday: {
    defaultInterval: '5m',
  },
};

const CONFIG_PATH = dexterPath('strategy.json');

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export function loadStrategyConfig(): StrategyConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return DEFAULT_STRATEGY_CONFIG;
    }
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return deepMerge(
      DEFAULT_STRATEGY_CONFIG as unknown as Record<string, unknown>,
      parsed,
    ) as unknown as StrategyConfig;
  } catch {
    return DEFAULT_STRATEGY_CONFIG;
  }
}

export function saveStrategyConfig(config: StrategyConfig): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function getStrategyConfigPath(): string {
  return CONFIG_PATH;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepMerge(defaults: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (
      overrides[key] &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(overrides[key]) &&
      defaults[key] &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key])
    ) {
      result[key] = deepMerge(
        defaults[key] as Record<string, unknown>,
        overrides[key] as Record<string, unknown>,
      );
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}
