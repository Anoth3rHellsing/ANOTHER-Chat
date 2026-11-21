import { useEffect, useState } from 'react';

const fileKeys = new WeakMap<File, number>();
let nextFileKey = 0;

/**
 * Clave estable por archivo: al quitar uno, los demás conservan su miniatura y
 * su referencia en vez de heredar la del índice anterior.
 */
export function pendingFileKey(file: File): number {
  let key = fileKeys.get(file);
  if (key === undefined) {
    key = ++nextFileKey;
    fileKeys.set(file, key);
  }
  return key;
}

/**
 * Miniatura de una imagen pendiente de enviar.
 *
 * La referencia `blob:` vive exactamente lo que vive esta miniatura: se crea al
 * montarla (o al cambiar de archivo) y se revoca al desmontarla, ya sea porque
 * se quitó el adjunto, porque se envió el mensaje o porque se cerró la vista.
 * Crearla en el render generaba una referencia nueva en cada pulsación de tecla
 * que nadie liberaba.
 */
export function PendingImagePreview({ file, className }: { file: File; className?: string }) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Si cambia el archivo, la referencia anterior ya está revocada: no se pinta.
  if (!preview || preview.file !== file) return <div className={className} aria-hidden="true" />;
  return <img src={preview.url} alt={file.name} className={className} />;
}
