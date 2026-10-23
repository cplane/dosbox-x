/**
 * The debugger's media-style buttons, one set for the editor's bar and the Machine view's, so the same action
 * looks the same in both.
 */
export const Icon = {
  // Continue (play to the next breakpoint or the end): the triangle, then a bar.
  play: <svg viewBox="0 0 16 16" aria-hidden><path d="M2.5 2.5v11l7.5-5.5z" fill="currentColor" /><rect x="11.5" y="2.5" width="2.2" height="11" rx="0.6" fill="currentColor" /></svg>,
  pause: <svg viewBox="0 0 16 16" aria-hidden><rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8" fill="currentColor" /><rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8" fill="currentColor" /></svg>,
  stop: <svg viewBox="0 0 16 16" aria-hidden><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg>,
  // Start (build, then debug from the beginning): the plain triangle.
  start: <svg viewBox="0 0 16 16" aria-hidden><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>,
  over: <svg viewBox="0 0 16 16" aria-hidden><path d="M3 8.5a5 5 0 0 1 9.2-2.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M12.5 2.5v3.6h-3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="12.6" r="1.7" fill="currentColor" /></svg>,
  // Step out: up and out of the function.
  out: <svg viewBox="0 0 16 16" aria-hidden><path d="M8 10V3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M5 6l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="13" r="1.7" fill="currentColor" /></svg>,
  into: <svg viewBox="0 0 16 16" aria-hidden><path d="M8 1.8v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="13" r="1.7" fill="currentColor" /></svg>,
  // Step on its own, one instruction after another at a set speed: the triangle drawn hollow, ticks behind it.
  steps: <svg viewBox="0 0 16 16" aria-hidden><path d="M6 3v10l7.5-5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><circle cx="2.3" cy="5" r="1" fill="currentColor" /><circle cx="2.3" cy="8" r="1" fill="currentColor" /><circle cx="2.3" cy="11" r="1" fill="currentColor" /></svg>,
  // Record a run to replay.
  record: <svg viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="5" fill="currentColor" /></svg>,
  // Copy: two sheets, one over the other; then a tick once copied.
  copy: <svg viewBox="0 0 16 16" aria-hidden><rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v6A1.5 1.5 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>,
  check: <svg viewBox="0 0 16 16" aria-hidden><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  // Open in the editor: a page with an arrow going into it.
  openFile: <svg viewBox="0 0 16 16" aria-hidden><path d="M6.5 1.5h4l3 3v9a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M10.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M1.5 8h6.5M6 5.8 8.2 8 6 10.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  // Replay: to the first instruction, back one, forward one.
  first: <svg viewBox="0 0 16 16" aria-hidden><rect x="2.5" y="2.5" width="2.2" height="11" rx="0.6" fill="currentColor" /><path d="M13.5 2.5v11L6 8z" fill="currentColor" /></svg>,
  back: <svg viewBox="0 0 16 16" aria-hidden><path d="M11 3.5v9L4.5 8z" fill="currentColor" /></svg>,
  forward: <svg viewBox="0 0 16 16" aria-hidden><path d="M5 3.5v9L11.5 8z" fill="currentColor" /></svg>,
}
