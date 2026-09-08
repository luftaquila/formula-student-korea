export function balancedRowSizes(count, capacity) {
  const rowCount = Math.ceil(count / capacity);
  const size = Math.floor(count / rowCount);
  const extra = count % rowCount;
  return Array.from({ length: rowCount }, (_, index) => size + (index < extra ? 1 : 0));
}
