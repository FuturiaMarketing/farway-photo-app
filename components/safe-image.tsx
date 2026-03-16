"use client";

import { useEffect, useRef, useState } from 'react';
import NextImage, { type ImageProps } from 'next/image';

const fallbackSrc = '/product-placeholder.svg';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

function getNormalizedSrc(src: ImageProps['src']) {
  if (typeof src !== 'string') {
    return src;
  }

  return src.trim().length > 0 ? src : fallbackSrc;
}

function withRetryParam(src: string, attempt: number): string {
  // Adds _r=N to the proxy URL so the browser makes a fresh request,
  // while the server-side DB cache key (the `url` param) stays unchanged.
  try {
    const u = new URL(src, 'http://x');
    u.searchParams.set('_r', String(attempt));
    return u.pathname + u.search;
  } catch {
    return src;
  }
}

export default function SafeImage(props: ImageProps) {
  const { src, onError, ...rest } = props;
  const normalizedSrc = getNormalizedSrc(src);
  const [currentSrc, setCurrentSrc] = useState<ImageProps['src']>(normalizedSrc);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    retriesRef.current = 0;
    setCurrentSrc(getNormalizedSrc(src));
  }, [src]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return (
    <NextImage
      {...rest}
      src={currentSrc}
      onError={(event) => {
        const isProxyUrl =
          typeof currentSrc === 'string' &&
          currentSrc !== fallbackSrc &&
          currentSrc.includes('/api/external-image');

        if (isProxyUrl && retriesRef.current < MAX_RETRIES) {
          retriesRef.current += 1;
          const attempt = retriesRef.current;
          const originalSrc = typeof src === 'string' ? src : '';

          timerRef.current = setTimeout(() => {
            setCurrentSrc(withRetryParam(originalSrc, attempt));
          }, RETRY_DELAY_MS * attempt);
        } else if (typeof currentSrc === 'string' && currentSrc !== fallbackSrc) {
          setCurrentSrc(fallbackSrc);
        }

        onError?.(event);
      }}
    />
  );
}
