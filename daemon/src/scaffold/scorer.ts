import { StackTemplate } from './types';

export interface ScoredTemplate {
  templateId: string;
  score: number; // 0.0–1.0 normalized
  matchedKeywords: string[];
}

/**
 * Tokenize a description into lowercase words and bigrams.
 */
function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g) || [];
  const tokens = new Set<string>(words);

  // Add bigrams (consecutive word pairs)
  for (let i = 0; i < words.length - 1; i++) {
    tokens.add(`${words[i]} ${words[i + 1]}`);
  }

  return tokens;
}

/**
 * Score templates against a user description.
 * Pure function, no I/O.
 *
 * Weights:
 *  - useCases substring match: 5
 *  - primaryKeywords token match: 3
 *  - typeSignals synonym match: 2
 *  - secondaryKeywords token match: 1
 *  - tags token match: 0.5
 */
export function scoreTemplates(templates: StackTemplate[], description: string): ScoredTemplate[] {
  if (!description || !description.trim()) {
    return templates.map((t) => ({ templateId: t.id, score: 0, matchedKeywords: [] }));
  }

  const descLower = description.toLowerCase();
  const tokens = tokenize(description);

  const rawScores: { templateId: string; raw: number; matchedKeywords: string[] }[] = [];
  let maxRaw = 0;

  for (const template of templates) {
    let raw = 0;
    const matched: string[] = [];
    const scoring = template.scoring;

    if (scoring) {
      // useCases: substring match against full description (weight 5)
      for (const useCase of scoring.useCases) {
        if (descLower.includes(useCase.toLowerCase())) {
          raw += 5;
          matched.push(useCase);
        }
      }

      // primaryKeywords: token match (weight 3)
      for (const kw of scoring.primaryKeywords) {
        if (tokens.has(kw.toLowerCase())) {
          raw += 3;
          matched.push(kw);
        }
      }

      // typeSignals: synonym match (weight 2 * signal value)
      for (const [signal, value] of Object.entries(scoring.typeSignals)) {
        if (tokens.has(signal.toLowerCase())) {
          raw += 2 * value;
          matched.push(signal);
        }
      }

      // secondaryKeywords: token match (weight 1)
      for (const kw of scoring.secondaryKeywords) {
        if (tokens.has(kw.toLowerCase())) {
          raw += 1;
          matched.push(kw);
        }
      }
    }

    // tags: token match (weight 0.5)
    for (const tag of template.tags) {
      if (tokens.has(tag.toLowerCase())) {
        raw += 0.5;
        if (!matched.includes(tag)) {
          matched.push(tag);
        }
      }
    }

    if (raw > maxRaw) maxRaw = raw;
    rawScores.push({ templateId: template.id, raw, matchedKeywords: matched });
  }

  // Normalize to 0.0–1.0
  return rawScores
    .map((s) => ({
      templateId: s.templateId,
      score: maxRaw > 0 ? Math.round((s.raw / maxRaw) * 100) / 100 : 0,
      matchedKeywords: s.matchedKeywords,
    }))
    .sort((a, b) => b.score - a.score || a.templateId.localeCompare(b.templateId));
}
