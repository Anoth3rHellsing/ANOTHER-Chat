import { csrfFetch, readCsrfToken, CSRF_HEADER_NAME } from '@workspace/api-client-react';

export interface ChunkedUploadProgress {
  uploaded: number;
  total: number;
}

export class ChunkedUploader {
  private readonly controller = new AbortController();
  private uploadId: string | null = null;
  private activeRequest: XMLHttpRequest | null = null;

  constructor(private readonly file: File, private readonly channelId: number) {}

  private get base() {
    return `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/channels/${this.channelId}/files/uploads`;
  }

  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return csrfFetch(url, {
      ...init,
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
  }

  private async errorFrom(response: Response): Promise<Error> {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    return new Error(data?.error ?? `La operación falló (HTTP ${response.status}).`);
  }

  private sendChunk(
    uploadId: string,
    offset: number,
    chunk: Blob,
    onProgress?: (progress: ChunkedUploadProgress) => void,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.activeRequest = xhr;
      const clear = () => {
        this.controller.signal.removeEventListener('abort', onAbort);
        if (this.activeRequest === xhr) this.activeRequest = null;
      };
      const onAbort = () => xhr.abort();
      xhr.open('POST', `${this.base}/${encodeURIComponent(uploadId)}/chunks?offset=${offset}`);
      xhr.withCredentials = true;
      xhr.timeout = 120_000;
      const csrf = readCsrfToken();
      if (csrf) xhr.setRequestHeader(CSRF_HEADER_NAME, csrf);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress?.({ uploaded: Math.min(this.file.size, offset + event.loaded), total: this.file.size });
        }
      };
      xhr.onload = () => {
        clear();
        let body: { offset?: number; error?: string } = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(body.error ?? `El fragmento falló (HTTP ${xhr.status}).`));
        } else if (!Number.isSafeInteger(body.offset) || body.offset! <= offset) {
          reject(new Error('El servidor no confirmó el avance de la subida.'));
        } else {
          resolve(body.offset!);
        }
      };
      xhr.onerror = () => { clear(); reject(new Error('Se interrumpió la conexión durante la subida.')); };
      xhr.ontimeout = () => { clear(); reject(new Error('Se agotó el tiempo de espera del fragmento.')); };
      xhr.onabort = () => { clear(); reject(new Error('Subida cancelada.')); };
      this.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (this.controller.signal.aborted) { onAbort(); return; }
      const form = new FormData();
      form.append('chunk', chunk);
      xhr.send(form);
    });
  }

  async start(onProgress?: (progress: ChunkedUploadProgress) => void): Promise<{ fileId: number }> {
    try {
      if (this.controller.signal.aborted) throw new Error('Subida cancelada.');
      let session: { uploadId: string; offset: number; chunkSize: number; completedFileId?: number | null };
      if (this.uploadId) {
        const status = await this.request(`${this.base}/${encodeURIComponent(this.uploadId)}`, { method: 'GET' }, 30_000);
        if (status.status === 404) {
          this.uploadId = null; // Expired or invalid; only then start a fresh session.
        } else {
          if (!status.ok) throw await this.errorFrom(status);
          session = await status.json();
          if (session.completedFileId) {
            this.uploadId = null;
            onProgress?.({ uploaded: this.file.size, total: this.file.size });
            return { fileId: session.completedFileId };
          }
        }
      }
      if (!this.uploadId) {
        const init = await this.request(this.base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: this.file.name, sizeBytes: this.file.size }),
        }, 30_000);
        if (!init.ok) throw await this.errorFrom(init);
        session = await init.json();
      }
      if (!session! || !session.uploadId || !Number.isSafeInteger(session.offset) || !Number.isSafeInteger(session.chunkSize) || session.chunkSize < 1) {
        throw new Error('El servidor devolvió una sesión de subida inválida.');
      }
      this.uploadId = session!.uploadId;
      let offset = session!.offset;
      onProgress?.({ uploaded: offset, total: this.file.size });
      while (offset < this.file.size) {
        if (this.controller.signal.aborted) throw new Error('Subida cancelada.');
        const chunk = this.file.slice(offset, Math.min(offset + session!.chunkSize, this.file.size));
        let failure: Error | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            offset = await this.sendChunk(session!.uploadId, offset, chunk, onProgress);
            failure = undefined;
            break;
          } catch (error) {
            failure = error instanceof Error ? error : new Error('Error de subida.');
            if (this.controller.signal.aborted) throw new Error('Subida cancelada.');
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1500));
          }
        }
        if (failure) throw new Error(`${failure.message} Puedes reintentar la subida.`);
        onProgress?.({ uploaded: offset, total: this.file.size });
      }
      const done = await this.request(`${this.base}/${encodeURIComponent(session!.uploadId)}/finish`, { method: 'POST' }, 90_000);
      if (!done.ok) throw await this.errorFrom(done);
      const file = await done.json() as { id: number };
      this.uploadId = null;
      return { fileId: file.id };
    } catch (error) {
      if (this.controller.signal.aborted) {
        await this.cleanup();
        throw new Error('Subida cancelada.');
      }
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('La subida tardó demasiado. Puedes reintentarlo.');
      }
      throw error;
    }
  }

  private async cleanup() {
    const id = this.uploadId;
    this.uploadId = null;
    if (id) {
      await csrfFetch(`${this.base}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  }

  abort() {
    this.controller.abort();
    this.activeRequest?.abort();
    void this.cleanup();
  }
}