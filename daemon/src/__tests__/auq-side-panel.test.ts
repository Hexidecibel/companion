import * as fs from 'fs';
import * as path from 'path';
import { parseTextChoicePrompt } from '../parser';
import { liveChoiceHighlightId } from '../handlers/session';

// ---------------------------------------------------------------------------
// Regression: AskUserQuestion prompts that render a right-hand option-preview
// panel (box-art drawn on the SAME terminal rows as the numbered options).
//
// Before the fix, the panel's box-art bled into every option label, the panel
// body bled into descriptions, and the "press n to add notes" / "Chat about
// this" affordances bled into the last option's description. See fixture
// auq-cc-locus.txt (a verbatim tmux capture).
// ---------------------------------------------------------------------------

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'auq-cc-locus.txt'), 'utf8');

// Every box-drawing / scissors glyph that could leak from the side panel.
const BOX_ART_GLYPHS = /[┌│├└┤┐┘╭╮╰╯─━═✂]/;

describe('parseTextChoicePrompt — side-by-side option preview panel', () => {
  const parsed = parseTextChoicePrompt(FIXTURE);

  it('parses the prompt', () => {
    expect(parsed).not.toBeNull();
  });

  it('extracts exactly 3 options', () => {
    expect(parsed!.options).toHaveLength(3);
  });

  it('leaves NO box-art glyphs in any label or description', () => {
    for (const opt of parsed!.options) {
      expect(opt.label).not.toMatch(BOX_ART_GLYPHS);
      expect(opt.description ?? '').not.toMatch(BOX_ART_GLYPHS);
    }
  });

  it('option 1: clean label + parenthetical description', () => {
    expect(parsed!.options[0].label).toBe('On cushbox directly');
    expect(parsed!.options[0].description).toBe('(Recommended)');
  });

  it('option 2: clean label, empty description', () => {
    expect(parsed!.options[1].label).toBe('From here, over tailnet');
    expect(parsed!.options[1].description).toBe('');
  });

  it('option 3: clean label, wrapped tail in description', () => {
    expect(parsed!.options[2].label).toBe('Just prove the bridge');
    // KNOWN MINOR LIMITATION (wrap-join deferred — STEP 3): the label wraps to a
    // second line ("first") that is indistinguishable, by indentation alone, from a
    // real description. Joining it into the label would risk every single-column box
    // whose options carry genuine descriptions, so it is intentionally NOT joined.
    // The goal label is "Just prove the bridge first"; today the "first" tail lands in
    // the description instead. The affordances ("Chat about this" / notes hint) must
    // NOT leak in alongside it.
    expect(parsed!.options[2].description).toBe('first');
  });

  it('does not leak the "Chat about this" / notes affordances anywhere', () => {
    for (const opt of parsed!.options) {
      const blob = `${opt.label} ${opt.description ?? ''}`;
      expect(blob).not.toMatch(/Chat about this/i);
      expect(blob).not.toMatch(/add notes/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: multi-question AskUserQuestion prompts must advance the chat to
// EACH question. A single AUQ tool_use can contain several question groups that
// advance one-at-a-time on the tmux pane with no JSONL change. The synthetic
// live highlight is keyed by liveChoiceHighlightId; if Q1 and Q2 collapsed to
// the same id the client would treat Q2 as already-seen and freeze on Q1.
// ---------------------------------------------------------------------------
describe('liveChoiceHighlightId — multi-question advance', () => {
  const session = 'companion-out4-mqzkzmg2';
  const q1 = {
    header: 'Visibility',
    question: "What should a semi-private event's visibility be from the OWNER's dashboard?",
    options: [{ label: 'Public' }, { label: 'Private' }, { label: 'Hidden' }, { label: 'Custom' }],
  };
  const q2 = {
    header: 'Scope',
    question: 'How widespread is this — is anyone besides this owner affected?',
    options: [
      { label: 'Just this owner' },
      { label: 'Some owners' },
      { label: 'All owners' },
      { label: 'Unsure' },
    ],
  };

  it('is stable for the same question across repeated captures', () => {
    expect(liveChoiceHighlightId(session, q1)).toBe(liveChoiceHighlightId(session, q1));
  });

  it('differs between two distinct questions in the same session', () => {
    expect(liveChoiceHighlightId(session, q1)).not.toBe(liveChoiceHighlightId(session, q2));
  });

  it('changes when only the option labels change', () => {
    const q1b = {
      ...q1,
      options: [
        { label: 'Public' },
        { label: 'Private' },
        { label: 'Hidden' },
        { label: 'Owner-only' },
      ],
    };
    expect(liveChoiceHighlightId(session, q1)).not.toBe(liveChoiceHighlightId(session, q1b));
  });

  it('namespaces by session so different sessions never collide', () => {
    expect(liveChoiceHighlightId('sess-a', q1)).not.toBe(liveChoiceHighlightId('sess-b', q1));
  });

  it('preserves the live-choice-<session> prefix expected by the client', () => {
    expect(liveChoiceHighlightId(session, q1)).toMatch(new RegExp(`^live-choice-${session}-`));
  });
});
