import { useState } from 'react';
import { ChevronRight, Search, Sparkles, Wand } from 'lucide-react';
import { EFFECT_CATEGORIES, EFFECTS } from '../../effects/catalog';
import { addEffectToSelection } from '../../state/actions';
import { PRESETS, applyPreset } from '../presets';

export function EffectsPanel() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ 'Animation Presets': true });
  const query = q.trim().toLowerCase();
  const match = (s: string) => !query || s.toLowerCase().includes(query);
  const groups: { name: string; items: { id: string; name: string; desc: string; kind: 'fx' | 'preset' }[] }[] = [
    {
      name: 'Animation Presets',
      items: PRESETS.filter((p) => match(p.name) || match(p.description)).map((p) => ({ id: p.id, name: `${p.group === 'Text' ? 'T · ' : ''}${p.name}`, desc: p.description, kind: 'preset' as const })),
    },
    ...EFFECT_CATEGORIES.map((cat) => ({
      name: cat,
      items: EFFECTS.filter((e) => e.category === cat && (match(e.name) || match(e.description) || match(cat))).map((e) => ({ id: e.type, name: e.name, desc: e.description, kind: 'fx' as const })),
    })),
  ].filter((g) => g.items.length);
  return (
    <div className="fxp">
      <div className="panel-toolbar">
        <div className="search">
          <Search size={12} />
          <input placeholder={`Search ${EFFECTS.length} effects & ${PRESETS.length} presets`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      </div>
      <div className="scroll fxp-list">
        {groups.map((g) => {
          const isOpen = query ? true : !!open[g.name];
          return (
            <div key={g.name} className="fxp-group">
              <div className="fxp-cat" onClick={() => setOpen({ ...open, [g.name]: !isOpen })}>
                <span className={`twirl${isOpen ? ' open' : ''}`}><ChevronRight size={11} /></span>
                {g.name === 'Animation Presets' ? <Wand size={12} className="fxp-ic preset" /> : <Sparkles size={12} className="fxp-ic" />}
                <span>{g.name}</span>
                <span className="fxp-count">{g.items.length}</span>
              </div>
              {isOpen && g.items.map((it) => (
                <div
                  key={it.id}
                  className="fxp-item"
                  title={`${it.desc}\nDouble-click to apply to selected layers${it.kind === 'fx' ? ', or drag onto a layer' : ''}`}
                  draggable={it.kind === 'fx'}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-poo-effect', it.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDoubleClick={() => (it.kind === 'fx' ? addEffectToSelection(it.id) : applyPreset(it.id))}
                >
                  <span className="fxp-name">{it.name}</span>
                  <span className="fxp-desc">{it.desc}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
