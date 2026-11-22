import { config } from './config.js';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Partes de fecha-hora en una zona horaria (default: config.TIMEZONE, '' = UTC).
// weekday sigue la convención JS getDay(): 0 domingo … 6 sábado.
export function tzParts(date = new Date(), timeZone) {
  const tz = timeZone ?? config.TIMEZONE ?? '';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const get = (type) => fmt.formatToParts(date).find((p) => p.type === type)?.value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    weekday: WEEKDAYS.indexOf(String(get('weekday')).toLowerCase()),
    year: String(get('year')),
    month: String(get('month')),
    day: String(get('day')),
    hour,
    minute: Number(get('minute'))
  };
}

export function tzDateString(parts = tzParts()) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}
