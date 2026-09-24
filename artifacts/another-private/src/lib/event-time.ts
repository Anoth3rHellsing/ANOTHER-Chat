export function convertToUTC(localDateTime: string): string {
  const date = new Date(localDateTime);
  if (isNaN(date.getTime())) {
    throw new Error('Invalid date');
  }
  return date.toISOString();
}

export function formatEventTime(
  utcIsoString: string, 
  originalTimeZone: string
): { formattedLocal: string; ianaLocal: string; formattedOrigin?: string; ianaOrigin?: string } {
  const date = new Date(utcIsoString);
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  
  const localFormatter = new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: browserTimeZone,
  });
  
  const result = {
    formattedLocal: localFormatter.format(date),
    ianaLocal: browserTimeZone,
  };

  if (originalTimeZone && originalTimeZone !== browserTimeZone) {
    try {
      const originFormatter = new Intl.DateTimeFormat('es', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: originalTimeZone,
      });
      return {
        ...result,
        formattedOrigin: originFormatter.format(date),
        ianaOrigin: originalTimeZone,
      };
    } catch (e) {
      // Fallback if invalid
    }
  }

  return result;
}

export function validateLocalTime(localDateTime: string): { valid: boolean; error?: string } {
  if (!localDateTime) return { valid: false, error: 'Fecha requerida' };
  
  const match = localDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return { valid: false, error: 'Formato inválido' };

  const d = new Date(localDateTime);
  if (isNaN(d.getTime())) return { valid: false, error: 'Fecha inválida' };

  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  const hh = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');

  if (
    parseInt(match[1], 10) !== y ||
    match[2] !== m ||
    match[3] !== dd ||
    match[4] !== hh ||
    match[5] !== min
  ) {
    return { valid: false, error: 'Hora inexistente por cambio de horario (brecha)' };
  }

  const beforeOffset = new Date(d.getTime() - 2 * 60 * 60 * 1000).getTimezoneOffset();
  const afterOffset = new Date(d.getTime() + 2 * 60 * 60 * 1000).getTimezoneOffset();
  if (beforeOffset < afterOffset) {
    const offsetDiffMs = (afterOffset - beforeOffset) * 60 * 1000;
    const dLocalStr = (date: Date) => {
      return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}T${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    };
    if (dLocalStr(new Date(d.getTime() + offsetDiffMs)) === localDateTime ||
        dLocalStr(new Date(d.getTime() - offsetDiffMs)) === localDateTime) {
      return { valid: false, error: 'Hora ambigua por traslape de horario (repite hora)' };
    }
  }

  return { valid: true };
}
