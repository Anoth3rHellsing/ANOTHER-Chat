import { convertToUTC, formatEventTime, validateLocalTime } from '../src/lib/event-time';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Timezone probe root element was not found');

const cases = [
  {
    id: 'summer',
    iso: '2027-07-15T20:00:00.000Z',
    localInput: { bogota: '2027-07-15T15:00', madrid: '2027-07-15T22:00' },
  },
  {
    id: 'winter',
    iso: '2027-01-15T20:00:00.000Z',
    localInput: { bogota: '2027-01-15T15:00', madrid: '2027-01-15T21:00' },
  },
];

function inputRoundTrip(localInput: string) {
  const utc = convertToUTC(localInput);
  const date = new Date(utc);
  const localAgain = [
    date.getFullYear(),
    '-',
    String(date.getMonth() + 1).padStart(2, '0'),
    '-',
    String(date.getDate()).padStart(2, '0'),
    'T',
    String(date.getHours()).padStart(2, '0'),
    ':',
    String(date.getMinutes()).padStart(2, '0'),
  ].join('');
  return { utc, localAgain };
}

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const eventMarkup = cases.map(({ id, iso, localInput }) => {
  const formatted = formatEventTime(iso, 'America/Bogota');
  const input = localInput[timezone === 'America/Bogota' ? 'bogota' : 'madrid'];
  const roundTrip = inputRoundTrip(input);
  return `
    <article data-testid="event-${id}" data-iso="${iso}">
      <h2>${id}</h2>
      <p data-testid="formatted-${id}">${formatted.formattedLocal}</p>
      <p data-testid="timezone-${id}">Zona horaria (tú): ${formatted.ianaLocal}</p>
      <p data-testid="iso-${id}">ISO original: ${iso}</p>
      <p data-testid="input-${id}">datetime-local: ${input}</p>
      <p data-testid="utc-${id}">UTC convertido: ${roundTrip.utc}</p>
      <p data-testid="roundtrip-${id}">datetime-local reconstruido: ${roundTrip.localAgain}</p>
    </article>
  `;
}).join('');

const gapInput = '2027-03-28T02:30';
const gapValidation = validateLocalTime(gapInput);
const overlapInput = '2027-10-31T02:30';
const overlapValidation = validateLocalTime(overlapInput);
root.innerHTML = `
  <h1>Channel event timezone verification</h1>
  <p data-testid="browser-timezone">Browser timezone: ${timezone}</p>
  ${eventMarkup}
  <p data-testid="dst-gap">
    Madrid DST-gap local time ${gapInput}: valid=${gapValidation.valid}
  </p>
  <p data-testid="dst-overlap">
    Madrid DST-overlap local time ${overlapInput}: valid=${overlapValidation.valid}
  </p>
`;

// The runner waits for this result before inspecting visible DOM text.
(window as Window & { timezoneProbeReady?: boolean }).timezoneProbeReady = true;