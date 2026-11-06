export function historyOffsets(ids: readonly string[], heights: ReadonlyMap<string, number>) {
  const offsets = [0]; let total = 0;
  for (const id of ids) { total += heights.get(id) || 100; offsets.push(total); }
  return offsets;
}
// First row whose bottom lies below the viewport's top. Exact boundaries belong
// to the next row; out-of-range positions clamp to the available history.
export function historyIndex(offsets: readonly number[], position: number) {
  let low = 0, high = Math.max(0, offsets.length - 2);
  while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid + 1] <= position) low = mid + 1; else high = mid; }
  return low;
}
