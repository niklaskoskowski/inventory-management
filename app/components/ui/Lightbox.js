import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { state, closePreview, previewNext, previewPrev } from '../../store.js';
import { lockScroll, unlockScroll } from '../../lib/scroll-lock.js';

/**
 * The one full-screen preview.
 *
 * Mounted once by AppShell and driven entirely by `state.preview`, so any
 * thumbnail anywhere opens it with a single store call and nothing has to pass
 * an overlay down through props. It sits above `.trax-drawer` (1055) because
 * most of the images that get clicked are inside a drawer.
 *
 * Escape is bound on `window` rather than `document`: the drawer's own capture
 * listener is on `document`, and window comes first in the capture phase, so
 * stopping propagation here closes the picture without also closing the drawer
 * underneath it.
 */
export default {
  name: 'Lightbox',
  setup() {
    const panel = ref(null);
    const previouslyFocused = ref(null);

    const preview = computed(() => state.preview);
    const count = computed(() => preview.value?.items?.length || 0);
    const hasGallery = computed(() => count.value > 1);

    /**
     * What the "Download" link names the file.
     *
     * A photo is a static URL, so its own basename is the honest name — the
     * title is the asset's, and a name with no extension makes the browser
     * guess. A document goes through download.php, which sends its own
     * Content-Disposition; that wins over this attribute, so the title is only
     * ever a fallback there.
     */
    const downloadName = computed(() => {
      const href = preview.value?.downloadHref || '';
      if (!href || href.includes('?')) return preview.value?.title || '';
      return href.split('/').pop() || '';
    });

    /** Bytes as an operator reads them — the same scale the sheet uses. */
    const formatSize = (bytes) => {
      const n = Number(bytes) || 0;
      if (!n) return '';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
      return `${(n / 1024 / 1024).toFixed(1)} MB`;
    };

    const onKeydown = (event) => {
      if (!state.preview) return;

      if (event.key === 'Escape') {
        event.stopPropagation();
        closePreview();
        return;
      }
      if (hasGallery.value && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.stopPropagation();
        event.preventDefault();
        if (event.key === 'ArrowRight') previewNext(); else previewPrev();
        return;
      }

      // Keep Tab inside the overlay while it is open.
      if (event.key === 'Tab' && panel.value) {
        const focusable = panel.value.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    // The overlay is v-if'd inside this component rather than by the parent, so
    // the lock and the focus handling hang off the state instead of a lifecycle
    // hook. unlockScroll() only ever undoes this component's own lock — an open
    // drawer keeps its own.
    let holding = false;
    watch(preview, async (now) => {
      if (now && !holding) {
        holding = true;
        previouslyFocused.value = document.activeElement;
        lockScroll();
      } else if (!now && holding) {
        holding = false;
        unlockScroll();
        previouslyFocused.value?.focus?.();
        previouslyFocused.value = null;
      }
      if (now) {
        // flush: 'post' below already runs this after the patch; the tick is
        // what covers the second open, where only the entry changed.
        await nextTick();
        panel.value?.querySelector('[data-autofocus]')?.focus();
      }
    }, { flush: 'post' });

    onMounted(() => window.addEventListener('keydown', onKeydown, true));
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKeydown, true);
      if (holding) { holding = false; unlockScroll(); }
    });

    return {
      panel, preview, count, hasGallery, formatSize, downloadName,
      closePreview, previewNext, previewPrev,
    };
  },
  template: `
    <template v-if="preview">
      <div class="trax-lightbox-backdrop" @click="closePreview()"></div>
      <div ref="panel" class="trax-lightbox" role="dialog" aria-modal="true"
           :aria-label="preview.title || 'Preview'">
        <header class="trax-lightbox-bar">
          <span class="trax-lightbox-title text-truncate">{{ preview.title || 'Preview' }}</span>
          <span v-if="hasGallery" class="trax-kind-chip">{{ preview.index + 1 }} / {{ count }}</span>
          <span class="flex-grow-1"></span>
          <a class="btn btn-sm btn-outline-secondary" :href="preview.downloadHref"
             :download="downloadName" aria-label="Download this file">
            <i class="bi bi-download"></i> Download
          </a>
          <a class="btn btn-sm btn-outline-secondary" :href="preview.src"
             target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab">
            <i class="bi bi-box-arrow-up-right"></i> Open
          </a>
          <button type="button" class="btn-close btn-close-white" data-autofocus
                  aria-label="Close the preview" @click="closePreview()"></button>
        </header>

        <div class="trax-lightbox-stage" @click.self="closePreview()">
          <img v-if="preview.kind === 'image'" class="trax-lightbox-image"
               :src="preview.src" :alt="preview.title || 'Preview'">

          <iframe v-else-if="preview.kind === 'pdf'" class="trax-lightbox-frame"
                  :src="preview.src" :title="preview.title || 'Document preview'"></iframe>

          <div v-else class="trax-card trax-lightbox-file">
            <div class="trax-card-pad text-center">
              <i class="bi bi-file-earmark-text d-block mb-2" style="font-size:2.5rem"></i>
              <div class="small text-truncate">{{ preview.title || 'File' }}</div>
              <div v-if="preview.size" class="text-secondary small">{{ formatSize(preview.size) }}</div>
              <p class="text-secondary small mt-2 mb-3">This type cannot be shown here.</p>
              <a class="btn btn-sm btn-primary" :href="preview.downloadHref"
                 :download="downloadName">
                <i class="bi bi-download"></i> Download
              </a>
            </div>
          </div>

          <template v-if="hasGallery">
            <button type="button" class="trax-lightbox-nav start-0" aria-label="Previous"
                    @click.stop="previewPrev()"><i class="bi bi-chevron-left"></i></button>
            <button type="button" class="trax-lightbox-nav end-0" aria-label="Next"
                    @click.stop="previewNext()"><i class="bi bi-chevron-right"></i></button>
          </template>
        </div>
      </div>
    </template>
  `,
};
