import { useState } from 'react';
import { Users } from 'lucide-react';
import { sameOriginUploadUrl } from '@/lib/media-url';

export function AvatarImage({ url }: { url: string }) {
  const src = sameOriginUploadUrl(url);
  const [failedSrc, setFailedSrc] = useState<string | undefined>();

  if (!src || failedSrc === src) {
    return <span className="flex h-full w-full items-center justify-center" aria-hidden="true"><Users className="h-1/2 w-1/2 text-muted-foreground" /></span>;
  }
  return <img src={src} onError={() => setFailedSrc(src)} className="w-full h-full object-cover" alt="" />;
}