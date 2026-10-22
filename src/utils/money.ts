/**
 * All money is stored as integer satang (THB cents, 1 baht = 100 satang) to
 * avoid floating point drift in financial calculations. Convert at the edges
 * (request parsing / response formatting) only.
 */
export function bahtToSatang(baht: number): number {
  return Math.round(baht * 100);
}

export function satangToBaht(satang: number): number {
  return Math.round(satang) / 100;
}

export function sumSatang(values: number[]): number {
  return values.reduce((acc, v) => acc + Math.round(v), 0);
}
