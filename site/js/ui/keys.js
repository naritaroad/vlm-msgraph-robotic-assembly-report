// keys.js — the keyboard map (the table in the Keys dialog of src/shell/index.html).
// Single keys do nothing while the person is typing, moving a slider, or inside a part that claims its
// own keys with data-keys="own". Modifier combinations are left to the browser.

import { isTyping } from './dom.js';
import * as prefs from './prefs.js';

export function initKeys({ nav, stage, timer, pop, lightbox, settings }) {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const key = e.key;

    if (key === 'Escape') {
      if (lightbox.anyOpen()) return;                       // <dialog> closes itself
      if (pop?.closeLast()) { e.preventDefault(); return; }
      if (settings?.close()) { e.preventDefault(); return; }
      if (stage.exitFull()) { e.preventDefault(); return; }
      if (nav.railOpen()) { nav.setRail(false); e.preventDefault(); }
      return;
    }
    if (lightbox.anyOpen() || isTyping(t)) return;

    const onControl = t instanceof Element && !!t.closest('button, a[href], summary, [role="tab"], [role="button"], [role="radio"], [role="separator"], video, audio');
    const inGroup = t instanceof Element && !!t.closest('[role="tablist"], [role="radiogroup"], [role="separator"]');
    const scrollsSideways = t instanceof Element && !!t.closest('.is-scroll');
    const inMedia = t instanceof Element && !!t.closest('video, audio');

    switch (key) {
      case 'ArrowRight': case 'PageDown':
        if (inGroup || inMedia || (scrollsSideways && key === 'ArrowRight')) return;
        e.preventDefault(); nav.next(); return;
      case 'ArrowLeft': case 'PageUp':
        if (inGroup || inMedia || (scrollsSideways && key === 'ArrowLeft')) return;
        e.preventDefault(); nav.prev(); return;
      case 'Home':
        if (inGroup || inMedia) return;
        e.preventDefault(); nav.toCover(); return;
      case ' ': case 'Spacebar':
        if (onControl) return;                              // Space presses the focused control
        if (nav.atCover()) return;                          // on the cover Space scrolls, as on any page
        e.preventDefault(); stage.primary(); return;
      case '1': case '2': case '3': case '4':
        e.preventDefault(); stage.show(stage.views[+key - 1], { focus: false }); return;
      case '?':
        e.preventDefault(); lightbox.showKeys(); return;
      case ',':
        e.preventDefault(); settings?.toggle(); return;
      default:
    }
    if (e.shiftKey) return;
    switch (key.toLowerCase()) {
      case 'l': e.preventDefault(); prefs.cycle('lang'); break;
      case 't': e.preventDefault(); prefs.toggleTheme(); break;
      case 's': e.preventDefault(); prefs.cycle('sync'); break;
      case 'v': e.preventDefault(); prefs.cycle('live'); break;
      case 'm': case 'o': e.preventDefault(); nav.toggleRail(); break;
      case 'p': e.preventDefault(); timer.togglePresent(); break;
      case 'f': e.preventDefault(); stage.toggleFull(); break;
      case 'r': e.preventDefault(); stage.dispatch('lab', 'reset', []); break;
      default:
    }
  });
}
