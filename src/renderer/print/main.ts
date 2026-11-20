import '../player/player.css';
import './print.css';
import { buildImagePage } from './imagePage.js';
import { buildPrintPages, printPageRule } from './pages.js';
import { waitForPdfDocument } from './readiness.js';
import { rewriteCssAssetUrls } from '../player/render.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'initial' || params.get('mode') === 'every'
  ? params.get('mode') as 'initial' | 'every'
  : 'final';
const includeHidden = params.get('includeHidden') === '1';
const slideFilter = params.get('slide');
const imageJobId = params.get('image');
const jobId = imageJobId ?? params.get('job') ?? '';

void (async () => {
  const session = await window.api.getDeck();
  if (!session) throw new Error('No deck is open');
  const theme = document.createElement('style');
  theme.textContent = rewriteCssAssetUrls(await window.api.loadTheme(), window.api.assetUrl);
  document.head.appendChild(theme);

  if (imageJobId) {
    // Copy as Image: one page the size of the window, captured rather than printed.
    const job = await window.api.copyImageJob(imageJobId);
    if (!job) throw new Error('The copy job is gone');
    const page = buildImagePage(document.getElementById('pages')!, job, window.api.assetUrl);
    await waitForPdfDocument([page]);
    document.documentElement.dataset.ready = 'true';
    window.api.pdfReady(jobId);
    return;
  }

  const { deck } = session;
  const pageRule = document.createElement('style');
  pageRule.textContent = printPageRule(deck);
  document.head.appendChild(pageRule);

  const pages = buildPrintPages(document.getElementById('pages')!, {
    deck,
    mode,
    includeHidden,
    slideFilter,
    resolveSrc: window.api.assetUrl,
  });
  await waitForPdfDocument(pages);
  document.documentElement.dataset.ready = 'true';
  window.api.pdfReady(jobId);
})().catch((error) => {
  document.documentElement.dataset.error = String(error instanceof Error ? error.message : error);
  window.api.pdfReady(jobId);
});
