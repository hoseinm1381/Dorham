export async function prepareAvatar(file: File): Promise<File> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 25 * 1048576) throw new Error('Choose a PNG, JPG or WebP image up to 25 MB.');
  // Decode into a bounded preview; the server still validates pixels and format.
  const bitmap = await createImageBitmap(file, { resizeWidth: 512, resizeQuality: 'high', imageOrientation: 'from-image' });
  try {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image could not be decoded.');
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
    if (!blob || blob.size > 96 * 1024) throw new Error('Image could not be decoded.');
    return new File([blob], 'avatar.webp', { type: blob.type });
  } finally { bitmap.close(); }
}
