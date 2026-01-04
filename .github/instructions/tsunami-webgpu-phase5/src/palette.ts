import ColorThief from 'colorthief';

/**
 * Returns N colors as linear RGB [0..1].
 * Uses ColorThief palette clustering on the uploaded image.
 */
export async function extractPaletteLinearSRGB(file: File, colorCount = 6): Promise<number[][]> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();

    // ColorThief expects the image to be in the DOM for some browsers.
    img.style.position = 'fixed';
    img.style.left = '-9999px';
    img.style.top = '-9999px';
    document.body.appendChild(img);

    const thief = new ColorThief();
    const palette = thief.getPalette(img, colorCount) ?? [];
    document.body.removeChild(img);

    // Convert sRGB 0..255 → linear 0..1
    return palette.slice(0, colorCount).map(([r, g, b]) => {
      const sr = r / 255, sg = g / 255, sb = b / 255;
      return [sr ** 2.2, sg ** 2.2, sb ** 2.2];
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
