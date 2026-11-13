/**
 * How many pages a PDF has, from its page objects. Chromium writes each as
 * a plain "/Type /Page" dictionary, so no PDF library is needed.
 */
export function countPdfPages(pdf: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(pdf);
  return (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

/** The base resume's print path, squeezed `fit` steps for "Fit to one page" (public issue 69); the token is signed for exactly this. */
export const printBasePath = (fit = 0) => (fit > 0 ? `/print/base?fit=${fit}` : "/print/base");
