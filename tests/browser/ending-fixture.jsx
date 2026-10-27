import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EndingPlayer } from '../../web/src/components/EndingPlayer';
import { ENDINGS } from '../../web/src/ending';
import '../../web/src/styles.css';

function Fixture() {
  const [kind, setKind] = useState(null);
  const facts = { terminal: { kind, day: 20, round: 5, detail: { cause: 'missed_opportunity' } }, siege: { grain: 20, pressure: 80, morale: 40 }, track: { cards: [], near: { name: { en: 'Shi Jingtang' } }, far: { name: { en: 'Yelü Deguang' } } } };
  return <main><h1>Ending integration check</h1>{Object.keys(ENDINGS).map(k => <button key={k} onClick={() => setKind(k)}>{k}</button>)}{kind ? <EndingPlayer key={kind} kind={kind} facts={facts} onClose={() => setKind(null)} onReview={() => setKind(null)} /> : null}</main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
