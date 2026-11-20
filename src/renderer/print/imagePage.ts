import type { CopyImageJob } from '@shared/copyImage.js';
import { resolveState } from '@shared/timeline.js';
import { renderSlide } from '../player/render.js';
import { applyStaticSlideState } from '../player/staticState.js';
import type { PrintPage } from './pages.js';

/**
 * One page holding a Copy as Image job: the job's slide at full canvas size,
 * scaled and shifted so the selection's bounds fill the page. Rendered and
 * settled exactly like a PDF page, so the picture matches the exported PDF.
 *
 * Unlike a PDF page it is captured, never printed, so the transform that
 * would upset print scaling (see printPageRule) is safe here.
 */
export function buildImagePage(
  container: HTMLElement,
  job: CopyImageJob,
  resolveSrc: (src: string) => string,
): PrintPage {
  const { bounds, scale, canvas, slide } = job;
  const page = document.createElement('section');
  page.className = 'pdf-page';
  page.style.width = `${Math.round(bounds.w * scale)}px`;
  page.style.height = `${Math.round(bounds.h * scale)}px`;
  const stage = document.createElement('div');
  stage.className = 'pdf-stage';
  stage.style.width = `${canvas.w}px`;
  stage.style.height = `${canvas.h}px`;
  stage.style.transform = `scale(${scale}) translate(${-bounds.x}px, ${-bounds.y}px)`;
  stage.appendChild(renderSlide(slide, { resolveSrc }));
  const state = resolveState(slide, 0);
  applyStaticSlideState(stage, slide, state);
  page.appendChild(stage);
  container.appendChild(page);
  return { page, slide, state };
}
