// Real UI components, controlled visible state, no live sessions.
import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NegotiationMap } from '../../web/src/components/NegotiationMap';
import { TermsEditor } from '../../web/src/components/terms';
import '../../web/src/styles.css';

const terms = { vassal: true, filial: true, cession: 'none', annual_silk: 10000, immediate_silk: 30000, aid_cavalry: 30000, aid_arrival_days: 15, neutrality: false, marriage_alliance: false, secret_clauses: [] };
const catalog = { pair: 'hedong-khitan', burdenPayer: 'hedong', terms: [
  { key: 'cession', label: { en: 'Cession of territory' }, type: 'enum', applicable: true, burdenByValue: { none: 0, yanmen_north: 30, lulong_only: 30, sixteen_prefectures: 60 }, payer: 'hedong', values: [['none', 'No cession'], ['yanmen_north', 'the prefectures north of Yanmen Pass only (not the Lulong circuit)'], ['lulong_only', 'the Lulong circuit only (not the prefectures north of Yanmen Pass)'], ['sixteen_prefectures', 'the whole Lulong circuit and the prefectures north of Yanmen Pass']].map(([value, en]) => ({ value, label: { en } })) },
  ...[['annual_silk', 'Annual silk', 500000, 10000], ['immediate_silk', 'Immediate silk', 300000, 10000], ['aid_cavalry', 'Relief cavalry', 60000, 5000], ['aid_arrival_days', 'Arrival days', 60, 5]].map(([key, label, max, step]) => ({ key, label: { en: label }, type: 'integer', applicable: true, min: 0, max, step, values: [], burdenWeight: 1, burdenUnit: 10000, payer: 'hedong' })),
] };
function Fixture() {
  const [state, setState] = useState(() => JSON.parse(sessionStorage.getItem('map-check-state') ?? 'null') ?? { cards: [], draft: { docId: 'doc A', version: 1 }, terminal: null });
  const [draft, setDraft] = useState(terms);
  useEffect(() => { sessionStorage.setItem('map-check-state', JSON.stringify(state)); }, [state]);
  useEffect(() => {
    window.setMapState = setState;
    window.mapTerms = terms;
    window.mapScenesSeen = [];
    const map = document.querySelector('.journey-map');
    const observer = new MutationObserver(() => window.mapScenesSeen.push(map.dataset.scene));
    observer.observe(map, { attributes: true, attributeFilter: ['data-scene'] });
    return () => observer.disconnect();
  }, []);
  return <main style={{ maxWidth: 680, margin: '20px auto', padding: 12 }}>
    <h1>Map interaction check</h1>
    <NegotiationMap track={{ cards: state.cards }} draft={state.draft} terminal={state.terminal} />
    <section className="panel" style={{ marginTop: 16 }}><h2>Edit terms</h2><TermsEditor value={draft} onChange={setDraft} catalog={catalog} lang="en" /></section>
  </main>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
