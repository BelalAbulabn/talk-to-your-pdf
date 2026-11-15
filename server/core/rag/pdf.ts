import { extractText, getDocumentProxy } from 'unpdf';
import { ApiError } from '../errors';

/** Checks the `%PDF-` magic bytes. */
export function isPdf(data: Uint8Array): boolean {
  return (
    data.length > 5 &&
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46 &&
    data[4] === 0x2d
  );
}

/** Returns the text of every page (index 0 = page 1). */
export async function readPdfPages(
  data: Uint8Array,
  maxPages: number,
): Promise<string[]> {
  if (!isPdf(data)) {
    throw new ApiError('not_pdf', 'This file is not a valid PDF.');
  }
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(data);
  } catch {
    throw new ApiError(
      'not_pdf',
      'This PDF could not be read. It may be damaged or password-protected.',
    );
  }
  try {
    if (pdf.numPages > maxPages) {
      throw new ApiError(
        'file_too_large',
        `This PDF has ${pdf.numPages} pages. The maximum is ${maxPages}.`,
      );
    }
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
