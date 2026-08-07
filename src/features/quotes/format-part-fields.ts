export function formatTolerance(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }

  const fixedValue = value.toFixed(4);
  const formattedValue = fixedValue.endsWith("0") ? fixedValue.slice(0, -1) : fixedValue;
  return `±${formattedValue} in`;
}

export function formatTextValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
