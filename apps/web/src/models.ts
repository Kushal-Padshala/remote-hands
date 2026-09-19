export type EffortLevel = 'high' | 'medium' | 'low';

export interface ModelOption {
  id: string;
  name: string;
  shortName: string;
  supportedEfforts: EffortLevel[];
}

export const SUPPORTED_MODELS: readonly ModelOption[] = [
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    shortName: 'Gemini 3.8',
    supportedEfforts: ['high', 'medium', 'low'],
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    shortName: 'Gemini 3.7',
    supportedEfforts: ['high', 'medium', 'low'],
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    shortName: 'Gemini 3.1',
    supportedEfforts: ['high', 'low'],
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    shortName: 'Claude Sonnet 4.6',
    supportedEfforts: [],
  },
  {
    id: 'claude-opus-4-6-thinking',
    name: 'Claude Opus 4.6',
    shortName: 'Claude Opus 4.6',
    supportedEfforts: [],
  },
  {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B',
    shortName: 'GPT-OSS 120B',
    supportedEfforts: ['medium'],
  },
] as const;

export const EFFORT_OPTIONS: readonly { value: EffortLevel; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] as const;

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_EFFORT: EffortLevel = 'high';

export function getModelOption(modelId?: string | null): ModelOption {
  if (!modelId) return SUPPORTED_MODELS[0]!;
  return SUPPORTED_MODELS.find((m) => m.id === modelId) || {
    id: modelId,
    name: modelId,
    shortName: modelId.replace(/-flash-high$/, '').replace(/-flash$/, ''),
    supportedEfforts: ['high', 'medium', 'low'],
  };
}

export function isClaudeModel(modelId?: string | null): boolean {
  return Boolean(modelId && modelId.toLowerCase().includes('claude'));
}

export function formatModelBadge(modelId?: string | null, effort?: string | null): string {
  const model = getModelOption(modelId);
  if (isClaudeModel(model.id) || !model.supportedEfforts.length) {
    return model.shortName;
  }
  const eff = effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : 'High';
  return `${model.shortName} · ${eff}`;
}

export function getValidEffortForModel(modelId: string, currentEffort: string): string {
  const option = getModelOption(modelId);
  if (option.supportedEfforts.length === 0 || isClaudeModel(modelId)) {
    return currentEffort;
  }
  if (option.supportedEfforts.includes(currentEffort as EffortLevel)) {
    return currentEffort;
  }
  return option.supportedEfforts[0]!;
}
