import '../player/player.css';
import '../print/print.css';
import type { CopyImageJob } from '@shared/copyImage.js';
import { rewriteCssAssetUrls } from '../player/render.js';
import { buildImagePage } from '../print/imagePage.js';
import { waitForPdfDocument } from '../print/readiness.js';
import { rasterizeDocument, type RasterizedPage } from './rasterize.js';

/**
 * The collab client's Copy as Image page, loaded in a hidden frame of the
 * editor: the desktop app's print page in image mode, drawn to a PNG here
 * because a browser cannot capture a window. See copyImageClipboard.ts.
 */

export interface CopyImageFrameRequest {
  job: CopyImageJob;
  themeCss: string;
  resolveSrc: (src: string) => string;
}

export type RenderCopyImage = (request: CopyImageFrameRequest) => Promise<RasterizedPage>;

const render: RenderCopyImage = async ({ job, themeCss, resolveSrc }) => {
  const theme = document.createElement('style');
  theme.textContent = rewriteCssAssetUrls(themeCss, resolveSrc);
  document.head.appendChild(theme);
  const page = buildImagePage(document.getElementById('pages')!, job, resolveSrc);
  await waitForPdfDocument([page]);
  return rasterizeDocument(
    document,
    Math.round(job.bounds.w * job.scale),
    Math.round(job.bounds.h * job.scale),
  );
};

(window as unknown as { renderCopyImage: RenderCopyImage }).renderCopyImage = render;
