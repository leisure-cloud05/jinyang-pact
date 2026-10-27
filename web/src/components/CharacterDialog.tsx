import type { CharacterView, Lang, StateView } from '../../../src/server/api-types';
import { characterTopics, type ConversationTopic } from '../character-topics';
import { BEARING_LABELS, BEARING_TONE, type Impression } from '../demeanor';
import { displayText, t } from '../labels';
import { CharacterPortrait } from './portrait';
import { Badge, Dialog } from './ui';

export function CharacterDialog({ character, state, impression, lang, onClose, onTopic }: {
  character: CharacterView;
  state: StateView;
  impression: Impression;
  lang: Lang;
  onClose: () => void;
  onTopic: (topic: ConversationTopic) => void;
}) {
  const zh = lang === 'zh';
  const canPrepare = character.present && !state.session.ended && !['finished', 'stopped', 'error', 'unavailable'].includes(state.control.state);
  return (
    <Dialog title={t(character.name, lang)} onEscape={onClose} tone="character" dismissOnBackdrop>
      <button type="button" className="btn-ghost character-close" onClick={onClose} aria-label={zh ? '关闭人物小传' : 'Close character profile'}>×</button>
      <div className="character-hero">
        <CharacterPortrait id={character.id} name={t(character.name, lang)} />
        <div>
          <p className="kicker">{zh ? '人物小传 · 河东议事' : 'Character profile · The council'}</p>
          <p>{t(character.title, lang)}</p>
          <Badge tone={BEARING_TONE[impression.bearing]}>{BEARING_LABELS[impression.bearing]}</Badge>
        </div>
      </div>
      <dl className="character-biography">
        {([
          ['background', zh ? '背景' : 'Background'],
          ['stance', zh ? '立场' : 'Position'],
          ['concern', zh ? '顾虑与切入点' : 'Concerns & openings'],
        ] as const).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{character.profile ? t(character.profile[key], lang) : zh ? '尚无公开小传，可在议事中向其询问。' : 'No public profile is available. Ask them during the council.'}</dd>
          </div>
        ))}
      </dl>
      <div className="character-observation">
        <h3 className="small-head">{zh ? '此刻观感' : 'Your reading of the room'}</h3>
        <p>{impression.reasons.map((reason) => displayText(reason, lang)).join(' ')}</p>
        <p className="hint">{zh ? '神态来自你观察到的言语与局势。小传提供进言切口，具体态度仍需交谈确认。' : 'Bearing reflects the words and circumstances you observe. The profile offers openings for counsel; ask them to learn their current position.'}</p>
      </div>
      <section className="character-counsel" aria-labelledby="character-topics-title">
        <h3 id="character-topics-title">{zh ? '下一轮，可以这样开口' : 'Openings for your next turn'}</h3>
        <p className="hint">{zh ? '结合当前表章与围城局势。点击词条，准备一段只对他进言的草稿；由你编辑并发送。' : 'Based on the current draft and siege. Choose a topic to prepare private counsel, then edit and send it yourself.'}</p>
        <div className="character-topics">
          {characterTopics(character.id, state).map((topic) => (
            <button key={topic.id} type="button" className="btn-secondary" disabled={!canPrepare} onClick={() => onTopic(topic)} title={t(topic.text, lang)}>{t(topic.label, lang)} <span aria-hidden="true">↗</span></button>
          ))}
        </div>
        {!canPrepare ? <p className="hint">{zh ? '当前无法向此人进言。' : 'Counsel is unavailable for this character right now.'}</p> : null}
      </section>
    </Dialog>
  );
}
