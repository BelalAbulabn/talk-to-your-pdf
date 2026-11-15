import { describe, expect, it } from 'vitest';
import { chunkPages } from './chunk';
import { isPdf, readPdfPages } from './pdf';

/** Builds a minimal valid PDF with one line of Helvetica text per page. */
function makePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const pageId = pageIds[i];
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets.push(pdf.length);
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('readPdfPages', () => {
  it('extracts the text of each page in order', async () => {
    const pages = await readPdfPages(
      makePdf(['Invoice number 4711', 'Delivery within 14 days']),
      50,
    );

    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('Invoice number 4711');
    expect(pages[1]).toContain('Delivery within 14 days');
    expect(chunkPages(pages)).toEqual([
      { page: 1, pageEnd: 1, text: 'Invoice number 4711' },
      { page: 2, pageEnd: 2, text: 'Delivery within 14 days' },
    ]);
  });

  it('rejects PDFs with too many pages', async () => {
    await expect(readPdfPages(makePdf(['a', 'b']), 1)).rejects.toThrow(
      /has 2 pages\. The maximum is 1/,
    );
  });

  it('rejects files that are not PDFs', async () => {
    const fake = new TextEncoder().encode('<html>not a pdf</html>');
    expect(isPdf(fake)).toBe(false);
    await expect(readPdfPages(fake, 50)).rejects.toThrow(/not a valid PDF/);
  });
});
