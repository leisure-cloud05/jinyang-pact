/**
 * Private counsel (附耳进言) through the API: a line said to one person present is stored with that single listener,
 * so the others present never hear it (a character's context holds only rows it heard: tests/agents/context.test.ts),
 * and the interaction ledger gives only that person an item to answer. Speech to several listeners, for contrast,
 * gives each of them one.
 */
import { expect, it } from 'vitest';
import type { DialogueView } from '../../src/server/api-types.js';
import type { Ledger } from '../../src/engine/interaction.js';
import { advance, createSession, get, input, makeApp, rid, state } from './helpers.js';

it('a whisper reaches only the chosen listener, who alone gets an item to answer', async () => {
  const { app, manager } = await makeApp();
  const id = await createSession(app, 'C1');
  const whisper = await input(app, id, { requestId: rid('whisper'), kind: 'dialogue', to: ['sang_weihan'], text: '（附耳低语）WHISPER-7Q' });
  expect(whisper.status).toBe(200);
  const aloud = await input(app, id, { requestId: rid('aloud'), kind: 'dialogue', to: ['shi_jingtang', 'sang_weihan'], text: 'ALOUD-7Q' });
  expect(aloud.status).toBe(200);

  const rows = (await get<DialogueView>(app, `/api/sessions/${id}/dialogue`)).json.rows;
  const w = rows.find((r) => r.text.includes('WHISPER-7Q'));
  const a = rows.find((r) => r.text.includes('ALOUD-7Q'));
  expect(w?.listeners).toEqual(['sang_weihan']);
  expect(a?.listeners).toEqual(['shi_jingtang', 'sang_weihan']);

  // End the turn: the council deliberates (offline mock characters) and the ledger is materialized.
  expect((await advance(app, id)).status).toBe(200);
  await state(app, id);
  const { harness } = manager.locate(id);
  const ledger = manager.recordsOf(harness).ledger(id, 'current') as Ledger | null;
  expect(ledger).not.toBeNull();
  const fromLine = (seq: number | undefined): string[][] =>
    (ledger?.items ?? []).filter((i) => i.source.dialogueSeq === seq).map((i) => [i.kind, i.responsible]);
  expect(fromLine(w?.seq)).toEqual([['address', 'sang_weihan']]);
  expect(fromLine(a?.seq)).toEqual([
    ['address', 'shi_jingtang'],
    ['address', 'sang_weihan'],
  ]);
});

it('refuses a whisper to someone who is not present (letters travel through the harness)', async () => {
  const { app } = await makeApp();
  const id = await createSession(app, 'C1');
  const r = await input(app, id, { requestId: rid('whisper'), kind: 'dialogue', to: ['yelu_deguang'], text: '（附耳低语）' });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('not_present');
});
