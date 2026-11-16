import { useEffect, useState } from "react";

/** Resolves an image URL that may need loading first (blob URLs in browser mode). */
export function useImageUrl(load: (() => Promise<string>) | null, deps: unknown[]): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!load) return;
    let alive = true;
    load().then((u) => { if (alive) setUrl(u); }).catch(() => { if (alive) setUrl(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return url;
}

export default function AsyncImage({ load, deps, ...props }: { load: () => Promise<string>; deps: unknown[] } &
  Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src">) {
  const url = useImageUrl(load, deps);
  return url ? <img src={url} {...props} /> : <div className={`img-placeholder ${props.className ?? ""}`} />;
}
