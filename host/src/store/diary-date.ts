export function matchesDiaryLocalDay(input: { localDay: string; timeZone: string; recordedAt: number }) {
  const { localDay, timeZone, recordedAt } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDay) || !Number.isSafeInteger(recordedAt)) {
    return false;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(recordedAt);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return localDay === `${part("year")}-${part("month")}-${part("day")}`;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}
