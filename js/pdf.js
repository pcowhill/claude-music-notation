// pdf.js
// Vector PDF export. We render each score page to its own SVG (via render.js)
// and convert that SVG straight to PDF vector geometry with svg2pdf.js — no
// rasterization, so noteheads/clefs/text stay crisp and selectable. US Letter,
// paginated to match the on-screen pages.

(function () {
'use strict';
const MN = (window.MN = window.MN || {});
const { renderPagesForPDF, PAGE_W, PAGE_H } = MN.render;

function sanitizeName(name) {
  return (name || 'score').replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '') || 'score';
}

// Convert one SVG element into the current PDF page, coping with both the
// jsPDF-plugin form (pdf.svg) and the standalone svg2pdf(element, pdf, opts) form.
async function svgToPdfPage(svg, pdf) {
  const opts = { x: 0, y: 0, width: PAGE_W, height: PAGE_H };
  if (typeof pdf.svg === 'function') {
    await pdf.svg(svg, opts);
    return;
  }
  const fn = window.svg2pdf && (window.svg2pdf.svg2pdf || window.svg2pdf);
  if (typeof fn === 'function') {
    await fn(svg, pdf, opts);
    return;
  }
  throw new Error('svg2pdf.js is not loaded.');
}

// Build a vector PDF document for the score. Returns { pdf, pageCount }.
async function buildPDF(score) {
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF is not loaded.');
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });

  const pages = renderPagesForPDF(score); // [{ svg, host }]
  try {
    for (let i = 0; i < pages.length; i++) {
      if (i > 0) pdf.addPage('letter', 'portrait');
      await svgToPdfPage(pages[i].svg, pdf);
    }
    return { pdf, pageCount: pages.length };
  } finally {
    // Always clean up the offscreen render hosts.
    pages.forEach((p) => { if (p.host && p.host.parentNode) p.host.parentNode.removeChild(p.host); });
  }
}

// Build and download the PDF. Returns the page count on success.
async function exportPDF(score) {
  const { pdf, pageCount } = await buildPDF(score);
  pdf.save(`${sanitizeName(score.name)}.pdf`);
  return pageCount;
}

MN.pdf = { buildPDF, exportPDF };
})();
