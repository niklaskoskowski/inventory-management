/**
 * One background-scroll lock, shared by every layer that takes over the screen.
 *
 * The drawer used to set and clear `body.style.overflow` on its own, which is
 * correct exactly while it is the only such layer. The lightbox can open on top
 * of an open drawer, and a plain clear on its way out would hand the page back
 * its scrollbar with the drawer still covering it. So the lock is counted: the
 * body is unlocked again only when the last holder lets go.
 */

let held = 0;

/** Takes a lock. Returns nothing; every caller must pair it with unlockScroll(). */
export function lockScroll() {
  held += 1;
  if (held === 1) document.body.style.overflow = 'hidden';
}

/** Releases one lock. The body scrolls again only at zero. */
export function unlockScroll() {
  held = Math.max(0, held - 1);
  if (held === 0) document.body.style.overflow = '';
}
