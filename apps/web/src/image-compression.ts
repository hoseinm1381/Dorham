// Local, optional picture conversion. No upload, third-party API or VPS decoding.
export async function compressPicture(file: File): Promise<File | null> {
  if (file.size <= 2 * 1048576 || file.size > 25 * 1048576 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return null;
  const bitmap = await createImageBitmap(file, { resizeWidth: 2560, resizeQuality: 'high', imageOrientation: 'from-image' });
  try {
    const canvas = document.createElement('canvas'), scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d'); if (!context) return null; context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.8, 0.65, 0.5]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
      if (blob && blob.type === 'image/webp' && blob.size <= 2 * 1048576 && blob.size < file.size) return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.webp`, { type: 'image/webp', lastModified: file.lastModified });
    }
    return null;
  } finally { bitmap.close(); }
}
