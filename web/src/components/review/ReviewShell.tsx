/**
 * Everything the review layer renders outside the message flow: the drawer,
 * the live feed, the ask-why and revert dialogs, and the toasts. Lives inside
 * <ReviewProvider>.
 */
import { useEffect, useState } from 'react';
import { ReviewDrawer } from './ReviewDrawer';
import { ReviewToasts } from './ReviewToasts';
import { RevertDialog } from './RevertDialog';
import { AskWhyPopover } from './AskWhyPopover';
import { LiveFeed } from './LiveFeed';
import { useReviewContext } from './ReviewContext';
import { useReviewLive, type LiveEventSource } from '../../hooks/useReviewLive';

export function ReviewShell({ liveSource }: { liveSource?: LiveEventSource | null }) {
  const ctx = useReviewContext();
  const liveOn = !!ctx && ctx.liveOn && ctx.drawer.open;
  const live = useReviewLive({
    serverId: ctx?.serverId ?? '',
    sessionId: ctx?.sessionId ?? '',
    on: liveOn,
    request: ctx?.request ?? (async () => { throw new Error('no review'); }),
    source: liveSource,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!liveOn) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [liveOn]);
  if (!ctx) return null;
  const a = ctx.actions;
  return (
    <>
      <ReviewDrawer
        onAsk={a?.ask}
        onRevertHunk={a?.revertHunk}
        onRevertFile={a?.revertFile}
        renderFileExtra={a?.fileExtra}
        onToggleLive={ctx.toggleLive}
        liveOn={ctx.liveOn}
        liveSlot={liveOn ? <LiveFeed entries={live.entries} error={live.error} now={now} /> : null}
        refreshKey={ctx.refreshKey}
      />
      {ctx.askTarget && (
        <AskWhyPopover
          sessionId={ctx.sessionId}
          hunk={ctx.askTarget.hunk}
          absPath={ctx.askTarget.absPath}
          path={ctx.askTarget.path}
          editId={ctx.askTarget.editId}
          turn={ctx.askTarget.turn}
          request={ctx.request}
          onClose={ctx.closeAsk}
          onSent={ctx.onAskSent}
        />
      )}
      {ctx.revertTarget && (
        <RevertDialog
          sessionId={ctx.sessionId}
          target={ctx.revertTarget.target}
          path={ctx.revertTarget.path}
          request={ctx.request}
          device={ctx.device}
          onClose={ctx.closeRevert}
          onDone={ctx.onRevertDone}
        />
      )}
      <ReviewToasts />
    </>
  );
}
