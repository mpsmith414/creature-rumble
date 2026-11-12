import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../../server/prompts';
import { MOVES } from '../../src/fight/types';

describe('the system prompt', () => {
  it('is stable (no dates) and insists on faithfulness', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/20\d\d-\d\d/);
    expect(SYSTEM_PROMPT).toMatch(/Never turn a drawing into a known animal/);
  });

  it('prompt asks for upright two-armed fighters and a fight plan', () => {
    for (const s of ['upright', 'two arms', 'fight.move', 'weapons', 'intro', '{maker}', 'punch', 'divebomb']) expect(SYSTEM_PROMPT).toContain(s);
    expect(SYSTEM_PROMPT).not.toMatch(/furLength 0\.005/);
  });

  it('describes every signature move', () => {
    for (const m of MOVES) expect(SYSTEM_PROMPT).toMatch(new RegExp(`^- ${m}:`, 'm'));
  });

  it('draws no fur: coverings are colours and patterns, furLength 0', () => {
    expect(SYSTEM_PROMPT).toContain('furLength 0');
    expect(SYSTEM_PROMPT).not.toMatch(/"shaggy"|"woolly"/);
  });

  it('keeps the kind-and-safe and kid-card sections', () => {
    for (const s of ['# Being kind and safe', '"noCreature"', '"declined"', '# Kid cards', '# The checklist', '# Looking again']) expect(SYSTEM_PROMPT).toContain(s);
    expect(SYSTEM_PROMPT).toMatch(/220 characters/);
  });
});

describe('the system prompt follows the drawing, not a house style', () => {
  it('drops the one-body-plan house style and the round-belly nudge', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/chunky exaggerated shapes/);
    expect(SYSTEM_PROMPT).not.toMatch(/big heads, big hands, round bellies/);
    expect(SYSTEM_PROMPT).not.toMatch(/second torso part on top for a chest or a round belly/);
  });

  it('asks to exaggerate what makes this drawing different and keep its silhouette, proportions, colours and patterns', () => {
    for (const s of ['what makes THIS drawing different', 'silhouette', 'proportions', 'patterns exactly as drawn'])
      expect(SYSTEM_PROMPT).toContain(s);
    for (const w of ['long', 'skinny', 'spiky', 'lumpy', 'flat', 'stripy', 'spotty', 'many-eyed']) expect(SYSTEM_PROMPT).toContain(w);
  });

  it('shows the worked examples as mechanics, not a template, with contrasting body shapes', () => {
    expect(SYSTEM_PROMPT).toContain('not a template');
    expect(SYSTEM_PROMPT).toContain('the drawing decides the shape');
    for (const s of ['A long thin body', 'A flat wide body', 'A tall spiky body']) expect(SYSTEM_PROMPT).toContain(s);
  });

  it('stands a long creature on its back legs but keeps its neck, tail, snout and body length', () => {
    expect(SYSTEM_PROMPT).toMatch(/stands on its back legs/);
    for (const s of ['long neck', 'long tail', 'long snout', 'body length']) expect(SYSTEM_PROMPT).toContain(s);
    expect(SYSTEM_PROMPT).toMatch(/don't squash it into a bean/i);
  });

  it('looks again at silhouette and patterns first', () => {
    const look = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('# Looking again'));
    expect(look).toMatch(/silhouette and patterns first/i);
  });
});
