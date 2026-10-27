import S from '../state.js';
import { $ } from '../utils.js';
import { getFollowed } from '../services/storage.js';

// Easter egg: while LD_JoseAngel991 is the selected or a starred player,
// the header logo turns red and reads "Maquinometro".
const MAQUINA = 'ld_joseangel991';

const _isMaquina = p =>
  [p.user_event_status?.best_identifier, p.player?.best_identifier]
    .some(n => n?.toLowerCase() === MAQUINA);

export function syncMaquina() {
  const ids = new Set(S.event ? getFollowed(S.event.id) : []);
  if (S.activeId) ids.add(S.activeId);
  const on = ids.size > 0 && Object.values(S.standings)
    .some(rows => rows.some(p => ids.has(p.id) && _isMaquina(p)));

  const logo = $('logo-btn');
  logo.classList.toggle('maquina', on);
  const pacto = logo.querySelector('.logo-pacto');
  if (!pacto) return;
  pacto.textContent = on ? 'Maquino' : 'Pacto';
  logo.setAttribute('aria-label', `${on ? 'Maquinometro' : 'Pactometro'} — go to the overview`);
}
