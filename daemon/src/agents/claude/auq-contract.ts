/**
 * What the AskUserQuestion reader (auq-box.ts) must get right, in one shape
 * shared by the live contract test (scripts/cc-contract.ts) and the frozen
 * fixtures (__tests__/fixtures/cc-contract/*.txt + .expected.json).
 */
import type { ParsedAuqBox } from './auq-box';

/** Footers the reader knows (auq.footer). Anything else is drift. */
export const KNOWN_AUQ_FOOTERS = [
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
  'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel',
];

export interface AuqContractView {
  screen: 'question' | 'review';
  header?: string;
  question?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string; selected?: boolean }>;
  tabs?: string[];
  activeTab?: number;
  preview?: true;
  hasOther?: boolean;
  submitRow?: 'Submit' | 'Next';
  review?: Array<{ question: string; answer: string }>;
  unparsed?: string[];
}

/** The parts of a parse the contract fixes (cursor and footer aside). */
export function auqContractView(b: ParsedAuqBox): AuqContractView {
  const a = b.auq;
  if (a.screen === 'review') {
    return { screen: 'review', review: a.review, unparsed: a.unparsed };
  }
  return {
    screen: a.screen,
    header: b.header,
    question: b.question,
    multiSelect: !!b.multiSelect,
    options: b.options.map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
      ...(b.multiSelect || o.selected ? { selected: !!o.selected } : {}),
    })),
    tabs: a.tabs?.map((t) => t.label),
    activeTab: a.tabs ? a.activeTab : undefined,
    preview: a.preview ? true : undefined,
    hasOther: !!a.other,
    submitRow: a.submitRow,
    unparsed: a.unparsed,
  };
}

/** JSON with undefined dropped, for exact comparison. */
export function contractJson(v: unknown): string {
  return JSON.stringify(v, null, 2);
}
