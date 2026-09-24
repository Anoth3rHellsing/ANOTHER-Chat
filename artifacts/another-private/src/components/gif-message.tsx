import { parseGiphyMessage } from "@/lib/giphy";

export function GifMessage({ content }: { content: string }) {
  const url = parseGiphyMessage(content);
  if (!url) {
    return <span className="whitespace-pre-wrap break-words">{content}</span>;
  }

  return (
    <span className="block max-w-full overflow-hidden rounded-lg" data-message-content-type="giphy-gif">
      <img
        src={url}
        alt="GIF de GIPHY"
        title="GIF de GIPHY"
        referrerPolicy="no-referrer"
        loading="lazy"
        className="max-h-72 max-w-full rounded-lg object-contain"
      />
    </span>
  );
}