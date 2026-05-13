function toMinutes(time) {
  const [hours, minutes] = String(time || '00:00').split(':').map((part) => Number.parseInt(part, 10));
  return (hours || 0) * 60 + (minutes || 0);
}

function toTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function generateSlots({ date, durationMinutes, workingHours, bookings = [], blocks = [], incrementMinutes = 30 }) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const windows = workingHours.filter((item) => item.enabled && item.day_of_week === day);
  const busy = [
    ...bookings.map((booking) => ({ start: toMinutes(booking.start_time), end: toMinutes(booking.end_time) })),
    ...blocks.map((block) => ({ start: toMinutes(block.start_time), end: toMinutes(block.end_time) }))
  ];

  const slots = [];
  windows.forEach((window) => {
    const start = toMinutes(window.start_time);
    const end = toMinutes(window.end_time);
    for (let cursor = start; cursor + durationMinutes <= end; cursor += incrementMinutes) {
      const slotEnd = cursor + durationMinutes;
      const isBusy = busy.some((item) => overlaps(cursor, slotEnd, item.start, item.end));
      if (!isBusy) slots.push({ date, startTime: toTime(cursor), endTime: toTime(slotEnd) });
    }
  });
  return slots;
}

export function hasOverlap({ startTime, endTime, bookings = [], blocks = [] }) {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  return [...bookings, ...blocks].some((item) => overlaps(start, end, toMinutes(item.start_time), toMinutes(item.end_time)));
}

export function addMinutes(time, minutes) {
  return toTime(toMinutes(time) + Number(minutes || 0));
}
