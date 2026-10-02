/**
 * Everything the review layer renders outside the message flow: the drawer,
 * its action dialogs and the toasts. Lives inside <ReviewProvider>.
 */
import { ReviewDrawer } from './ReviewDrawer';
import { ReviewToasts } from './ReviewToasts';

export function ReviewShell() {
  return (
    <>
      <ReviewDrawer />
      <ReviewToasts />
    </>
  );
}
