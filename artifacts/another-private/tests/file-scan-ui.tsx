// Standalone, synthetic-only dev preview. Never reads the authenticated app or its data.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FileScanResult, scanPresentation, type FileScan } from '../src/components/file-scan-result';
import '../src/index.css';

const sha256 = 'a'.repeat(64);
const base: FileScan = {
  status: 'completed', sha256,
  harmless: 63, undetected: 7, suspicious: 0, malicious: 0,
  source: 'upload', submittedBy: 73, submittedByName: 'Persona que solicitó el análisis',
  submittedAt: '2026-09-24T10:00:00.000Z', completedAt: '2026-09-24T10:05:00.000Z',
};
const scans: [number, string, FileScan][] = [
  [1, 'sin-detecciones.zip', base],
  [2, 'con-detecciones.zip', { ...base, suspicious: 1, malicious: 2 }],
  [3, 'no-concluyente.zip', { ...base, status: 'error', harmless: null, undetected: null, suspicious: null,
    malicious: null, error: 'El análisis expiró', completedAt: null }],
  [4, 'no-analizado.zip', { ...base, status: 'not_started' }],
  [5, 'en-curso.zip', { ...base, status: 'in_progress', harmless: null, undetected: null, suspicious: null,
    malicious: null, completedAt: null }],
  [6, 'sin-motores.zip', { ...base, harmless: 0, undetected: 0, suspicious: 0, malicious: 0 }],
];
const root = createRoot(document.getElementById('root')!);
function render(pending: FileScan = scans[4][2]) {
  root.render(<main className="mx-auto max-w-xl space-y-4 bg-background p-6 text-foreground">
    <h1>Resultados de prueba (datos inventados)</h1>
    {scans.map(([id, filename, scan]) => (
      <section className="rounded-lg border border-border bg-card p-3" key={id}>
        <p>{filename}</p>
        <FileScanResult fileId={id} filename={filename} scan={id === 5 ? pending : scan} />
      </section>
    ))}
  </main>);
}
render();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const result = document.getElementById('results')!;
const failures: string[] = [];
function check(condition: boolean, description: string) {
  if (!condition) failures.push(description);
}
async function open(fileId: number) {
  document.querySelector<HTMLElement>(`[data-testid="button-file-scan-${fileId}"]`)?.click();
  await wait(60);
  return document.querySelector<HTMLElement>(`[data-testid="dialog-file-scan-${fileId}"]`);
}
async function close() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(110);
}
void (async () => {
  await wait(80);
  check(scanPresentation(scans[0][2]) === 'clear', 'sin detecciones');
  check(scanPresentation(scans[1][2]) === 'detected', 'con detecciones');
  check(scanPresentation(scans[2][2]) === 'inconclusive', 'error no concluyente');
  check(scanPresentation(scans[3][2]) === 'none', 'no analizado sin marca');
  check(scanPresentation(scans[5][2]) === 'inconclusive', 'cero motores no concluyente');
  check(!document.querySelector('[data-testid="button-file-scan-4"]'), 'no analizado sin botón');
  const clear = document.querySelector<HTMLElement>('[data-testid="button-file-scan-1"]');
  const flagged = document.querySelector<HTMLElement>('[data-testid="button-file-scan-2"]');
  check(Boolean(clear?.textContent?.includes('Sin detecciones') && clear?.className.includes('text-muted-foreground')), 'marca limpia discreta');
  check(Boolean(flagged?.textContent?.includes('3 motores') && flagged?.className.includes('bg-destructive') &&
    flagged?.className.includes('text-destructive-foreground') &&
    flagged?.className.includes('border-destructive')), 'marca de peligro prominente con 3 motores');
  check(Boolean(document.querySelector('[data-testid="button-file-scan-3"]')?.textContent?.includes('No concluyente')),
    'fallo distingue no concluyente');
  check(Boolean(document.querySelector('[data-testid="button-file-scan-6"]')?.textContent?.includes('No concluyente')),
    'cero motores distingue no concluyente');
  check(Boolean(document.querySelector('[data-testid="button-file-scan-5"]')?.textContent?.includes('Analizando')),
    'en curso muestra progreso');
  const dialog = await open(1);
  check(Boolean(dialog?.textContent?.includes('Persona que solicitó el análisis') &&
    dialog?.textContent?.includes('Inofensivo') && dialog?.textContent?.includes('63') &&
    dialog?.textContent?.includes('24/09/2026') && dialog?.textContent?.includes('no garantiza que el archivo sea seguro')),
    'clic abre detalle, recuentos, autor, fechas y advertencia');
  check(Boolean(dialog?.querySelector('a[href="https://www.virustotal.com/gui/file/' + sha256 + '/detection"]')),
    'detalle enlaza informe completo');
  await close();
  const detectedDialog = await open(2);
  check(Boolean(detectedDialog?.textContent?.includes('3 motores') &&
    detectedDialog?.textContent?.includes('Malicioso') && detectedDialog?.textContent?.includes('2')),
    'clic abre detalle del resultado con detecciones');
  await close();
  render({ ...base, status: 'completed' });
  await wait(80);
  check(Boolean(document.querySelector('[data-testid="button-file-scan-5"]')?.textContent?.includes('Sin detecciones')),
    'marca pendiente se actualiza al completar sin recargar');
  result.textContent = failures.length ? `FAIL: ${failures.join('; ')}` : 'PASS: marcas, detalle interactivo y transición de estado';
  result.setAttribute('data-status', failures.length ? 'fail' : 'pass');
  console.log(result.textContent);
})().catch(error => {
  result.textContent = `FAIL: ${String(error)}`;
  result.setAttribute('data-status', 'fail');
});