#!/usr/bin/env node
/**
 * Generates web/src/styles/flair-tokens.css: the Aurora flair tokens
 * (--flair-*) for every theme x level (subtle = k 0.5, full = k 1).
 *
 * Ported from the approved "Flair Lab" mock (aurora direction). Off has no
 * block on purpose: with no --flair-* tokens every rule falls back to the
 * flat look. Edit THEMES / tokens() here, then run:
 *
 *   node web/scripts/gen-flair-tokens.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in sync with variables.css (a = accent-blue, b = accent-purple, c = spark).
const THEMES = {
  midnight: { a: '#3b82f6', aL: '#60a5fa', b: '#8b5cf6', bH: '#7c3aed', bL: '#a78bfa', border: '#334155', c: '#22d3ee' },
  ocean: { a: '#06b6d4', aL: '#22d3ee', b: '#0ea5e9', bH: '#0284c7', bL: '#38bdf8', border: '#1e3348', c: '#34d399' },
  forest: { a: '#10b981', aL: '#34d399', b: '#22c55e', bH: '#16a34a', bL: '#4ade80', border: '#1e3a2d', c: '#a3e635' },
  warm: { a: '#f59e0b', aL: '#fbbf24', b: '#f97316', bH: '#ea580c', bL: '#fb923c', border: '#342e24', c: '#f43f5e' },
  rose: { a: '#ec4899', aL: '#f472b6', b: '#d946ef', bH: '#c026d3', bL: '#e879f9', border: '#342238', c: '#8b9dff' },
  graphite: { a: '#64748b', aL: '#cbd5e1', b: '#8b97a8', bH: '#475569', bL: '#e2e8f0', border: '#2a2e36', c: '#7dd3fc' },
};

const AMBER = '#f59e0b';
const GREEN = '#22c55e';
const RED = '#ef4444';
const PINK = '#fb7185';

const round = (x) => Math.round(x * 1000) / 1000;
function A(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${round(alpha)})`;
}
const W = (alpha) => `rgba(255, 255, 255, ${round(alpha)})`;

function tokens(T, level) {
  const full = level === 'full';
  const k = full ? 1 : 0.5;
  const { a, aL, b, bH, bL, c } = T;
  const t = [];
  const put = (name, value) => t.push([`--flair-${name}`, value]);

  put('spark', c);
  put('bg-glow', `radial-gradient(48% 34% at 30% 22%, ${A(a, 0.42 * k)} 0%, transparent 72%), radial-gradient(44% 30% at 76% 36%, ${A(b, 0.34 * k)} 0%, transparent 72%), radial-gradient(52% 30% at 56% 80%, ${A(c, 0.24 * k)} 0%, transparent 74%)`);
  put('bg-drift', full ? '38s' : '0s');
  put('header-bg', `linear-gradient(100deg, ${A(a, 0.22 * k)}, ${A(b, 0.14 * k)} 55%, ${A(c, 0.12 * k)}), var(--bg-secondary)`);
  put('header-line', `linear-gradient(90deg, ${a}, ${b} 45%, ${c} 80%, transparent)`);
  put('wordmark-gradient', `linear-gradient(90deg, ${aL} 0%, ${c} 30%, ${bL} 55%, ${aL} 80%, ${c} 100%)`);
  put('wordmark-glow', `drop-shadow(0 0 14px ${A(b, 0.55 * k)})`);
  put('accent-gradient', `linear-gradient(115deg, ${a} 0%, ${bH} 42%, ${c} 100%)`);
  put('accent-size', '170% 100%');
  put('accent-shadow', `inset 0 1px 0 ${W(0.35 * k)}, inset 0 -1px 0 rgba(0, 0, 0, 0.18), 0 8px 22px -8px ${A(a, 0.85 * k)}, 0 6px 26px -10px ${A(b, 0.8 * k)}`);
  put('accent-shadow-hover', `inset 0 1px 0 ${W(0.45 * k)}, inset 0 -1px 0 rgba(0, 0, 0, 0.18), 0 10px 30px -8px ${A(b, k)}, 0 8px 34px -8px ${A(c, 0.75 * k)}`);
  put('sheen', full ? '0.9' : '0.4');
  put('edge-glow', `0 0 14px ${A(b, 0.8 * k)}`);
  put('card-border', `linear-gradient(140deg, ${A(aL, 0.65 * k)} 0%, ${A(b, 0.25 * k)} 35%, ${T.border} 60%, ${A(c, 0.5 * k)} 100%)`);
  put('card-wash', `linear-gradient(125deg, ${A(a, 0.1 * k)} 0%, transparent 45%, ${A(c, 0.06 * k)} 100%)`);
  put('card-highlight', `inset 0 1px 0 ${W(0.1 * k)}`);
  put('card-shadow', `0 12px 26px -16px rgba(0, 0, 0, 0.85), 0 0 22px -14px ${A(b, 0.9 * k)}`);
  put('active-stops', `${a}, ${c}, ${b}, ${aL}, ${a}`);
  put('selected-bg', `linear-gradient(100deg, ${A(a, 0.28 * k)}, ${A(b, 0.16 * k)} 55%, ${A(c, 0.1 * k)})`);
  put('waiting-stops', `${AMBER}, ${PINK}, #fde68a, ${A(AMBER, 0.35)}, ${AMBER}`);
  put('waiting-wash', `linear-gradient(100deg, ${A(AMBER, 0.2 * k)}, ${A(PINK, 0.08 * k)} 60%, transparent)`);
  put('halo-waiting', `0 0 26px -4px ${A(AMBER, 0.75 * k)}, 0 0 40px -10px ${A(PINK, 0.5 * k)}`);
  put('border-spin', full ? '6s' : '0s');
  put('glow-waiting', `0 0 12px 2px ${A(AMBER, 0.85 * k)}`);
  put('ring-waiting', '#fcd34d');
  put('glow-running', `0 0 10px 1px ${A(GREEN, 0.7 * k)}`);
  // Not in the mock: the app's "working" dot is the theme accent, not green.
  put('glow-working', `0 0 10px 1px ${A(a, 0.7 * k)}`);
  put('glow-error', `0 0 10px 1px ${A(RED, 0.65 * k)}`);
  put('chip-glow', `0 0 14px -2px ${A(b, 0.7 * k)}`);
  put('focus-ring', `0 0 0 3px ${A(b, 0.2 * k + 0.08)}, 0 0 26px -2px ${A(a, 0.6 * k)}, 0 0 34px -6px ${A(c, 0.5 * k)}`);
  put('orb-halo', `radial-gradient(circle at 40% 40%, ${A(a, 0.6 * k)} 0%, ${A(b, 0.3 * k)} 34%, ${A(c, 0.1 * k)} 52%, transparent 66%)`);
  put('orb-plasma', `conic-gradient(${a}, ${c}, ${b}, ${aL}, ${c}, ${a})`);
  put('orb-blur', full ? '11px' : '8px');
  put('orb-core', `radial-gradient(circle at 34% 26%, ${W(0.98)} 0%, ${W(0)} 26%), radial-gradient(circle at 70% 78%, ${A(c, 0.9)} 0%, transparent 46%), radial-gradient(circle at 50% 50%, ${aL} 0%, ${a} 46%, ${bH} 100%)`);
  put('orb-shadow', `0 0 30px 3px ${A(b, 0.75 * k)}, 0 0 60px 6px ${A(a, 0.35 * k)}, inset 0 -4px 10px rgba(0, 0, 0, 0.3)`);
  put('orb-wave', c);
  return t;
}

let out = `/* GENERATED by web/scripts/gen-flair-tokens.mjs. Do not edit by hand.
   Aurora flair tokens per theme x level. No block for Off: every consumer
   falls back to the flat look when these are unset. */\n`;
for (const [id, T] of Object.entries(THEMES)) {
  for (const level of ['subtle', 'full']) {
    const sel = `:root${id === 'midnight' ? '' : `.theme-${id}`}[data-flair="${level}"]`;
    out += `\n${sel} {\n${tokens(T, level).map(([n, v]) => `  ${n}: ${v};`).join('\n')}\n}\n`;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'styles', 'flair-tokens.css');
writeFileSync(target, out);
console.log(`wrote ${target}`);
