import { useBabysit } from '../../hooks/useBabysit';

/** Session header (desktop): "Babysit", or "Babysitting (4)" while a brief is active. */
export function BabysitHeaderButton({ serverId, sessionId, onClick }: { serverId: string | null; sessionId: string | null; onClick: () => void }) {
  const { available, babysit, active } = useBabysit(serverId, sessionId);
  if (!available) return null;
  return (
    <button
      className={`session-header-btn${active ? ' terminal-active' : ''}`}
      onClick={onClick}
      title={active ? 'Herald is answering this session\'s simple questions. Edit the brief' : 'Let Herald answer this session\'s simple questions for you'}
    >
      {active ? 'Babysitting' : 'Babysit'}
      {active && babysit && babysit.answersUsed > 0 && <span className="babysit-header-count">{babysit.answersUsed}</span>}
    </button>
  );
}
