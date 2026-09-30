import { useHeraldData, useHeraldUi, useHeraldVoiceCtx, useHeraldVoiceInputCtx } from '../../context/HeraldContext';
import { HeraldOrb } from './HeraldOrb';

interface HeraldLauncherProps {
  variant: 'sidebar' | 'mobile';
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Entry point button: mini live orb + unheard badge. */
export function HeraldLauncher({ variant }: HeraldLauncherProps) {
  const ui = useHeraldUi();
  const data = useHeraldData();
  const voice = useHeraldVoiceCtx();
  const input = useHeraldVoiceInputCtx();
  const open = variant === 'mobile' ? ui.screenOpen : ui.panelOpen;
  const count = data.unheardCount;
  const shortcut = isMac ? 'Cmd+J' : 'Ctrl+J';

  return (
    <button
      type="button"
      className={`herald-launcher herald-launcher--${variant}${open ? ' herald-launcher--open' : ''}${data.unheardBlocked > 0 ? ' herald-launcher--attention' : ''}${input.handsFreeActive ? ' herald-launcher--handsfree' : ''}`}
      onClick={ui.toggle}
      aria-pressed={variant === 'sidebar' ? open : undefined}
      aria-label={`${data.displayName}${count ? `, ${count} new` : ''}`}
      title={`${data.displayName} (${shortcut})${input.handsFreeActive ? ' · hands-free listening for "Hey Jarvis"' : ''}`}
    >
      <HeraldOrb presence={voice.supported && voice.speaking ? 'speaking' : data.presence} size={variant === 'mobile' ? 22 : 18} mini />
      {variant === 'mobile' && <span className="herald-launcher__name">{data.displayName}</span>}
      {count > 0 && <span className="herald-launcher__badge">{count > 9 ? '9+' : count}</span>}
    </button>
  );
}
