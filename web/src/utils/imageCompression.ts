const SIZE_THRESHOLD = 500 * 1024; // 500KB

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (_e) => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}

function hasPngTransparency(img: HTMLImageElement): boolean {
  const canvas = document.createElement('canvas');
  // Sample a small version to check alpha
  const size = Math.min(img.width, img.height, 64);
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob returned null'));
      },
      type,
      quality
    );
  });
}

export async function compressImage(
  file: File,
  maxWidth = 1920,
  maxQuality = 0.8
): Promise<File> {
  try {
    // Quick exit: small file that doesn't need resizing
    if (file.size <= SIZE_THRESHOLD) {
      // Still need to check dimensions — load image to verify
      const img = await loadImage(file);
      const needsResize = img.width > maxWidth;
      URL.revokeObjectURL(img.src);
      if (!needsResize) return file;
    }

    const img = await loadImage(file);
    const srcUrl = img.src;

    // Determine output format
    const isPng = file.type === 'image/png';
    const keepPng = isPng && hasPngTransparency(img);
    const outputType = keepPng ? 'image/png' : 'image/jpeg';
    const ext = keepPng ? '.png' : '.jpg';

    // Calculate dimensions
    let width = img.width;
    let height = img.height;
    if (width > maxWidth) {
      height = Math.round(height * (maxWidth / width));
      width = maxWidth;
    }

    // No resize needed and file is small enough — return original
    if (width === img.width && height === img.height && file.size <= SIZE_THRESHOLD) {
      URL.revokeObjectURL(srcUrl);
      return file;
    }

    // Draw to canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      URL.revokeObjectURL(srcUrl);
      return file;
    }
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(srcUrl);

    // Export
    const quality = keepPng ? undefined : maxQuality;
    const blob = await canvasToBlob(canvas, outputType, quality);

    // If compression made it bigger, return original
    if (blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, ext);
    return new File([blob], name, { type: outputType, lastModified: Date.now() });
  } catch {
    // On any error, return the original file
    return file;
  }
}
