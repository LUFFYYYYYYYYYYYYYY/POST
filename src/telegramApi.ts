import { MediaItem, UploadProgress } from './types';

const API_BASE = 'https://api.telegram.org/bot';

export async function testBotConnection(botToken: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}${botToken}/getMe`);
    const data = await res.json();
    if (data.ok) {
      return { ok: true, username: data.result.username };
    }
    return { ok: false, error: data.description || 'Unknown error' };
  } catch {
    return { ok: false, error: 'Network error. Check your internet connection.' };
  }
}

export interface SendMediaHandle {
  promise: Promise<{ ok: boolean; error?: string }>;
  abort: () => void;
}

export function sendMediaToTelegram(
  botToken: string,
  channelId: string,
  item: MediaItem,
  onProgress?: (progress: UploadProgress) => void,
  parseMode?: string
): SendMediaHandle {
  let xhrInstance: XMLHttpRequest | null = null;
  let aborted = false;

  const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    try {
      if (aborted) {
        resolve({ ok: false, error: 'Upload cancelled' });
        return;
      }

      const formData = new FormData();
      formData.append('chat_id', channelId);

      if (item.caption.trim()) {
        formData.append('caption', item.caption.trim());
        if (parseMode) {
          formData.append('parse_mode', parseMode);
        }
      }

      let endpoint: string;

      if (item.type === 'photo') {
        endpoint = 'sendPhoto';
        formData.append('photo', item.file);
      } else {
        endpoint = 'sendVideo';
        formData.append('video', item.file);
        formData.append('supports_streaming', 'true');
      }

      const xhr = new XMLHttpRequest();
      xhrInstance = xhr;
      const startTime = Date.now();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress && !aborted) {
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? e.loaded / elapsed : 0;
          onProgress({
            loaded: e.loaded,
            total: e.total,
            percent: Math.round((e.loaded / e.total) * 100),
            speed,
            startTime,
          });
        }
      });

      xhr.addEventListener('load', () => {
        if (aborted) {
          resolve({ ok: false, error: 'Upload cancelled' });
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.ok) {
            if (onProgress) {
              const elapsed = (Date.now() - startTime) / 1000;
              const fileSize = item.file.size;
              onProgress({
                loaded: fileSize,
                total: fileSize,
                percent: 100,
                speed: elapsed > 0 ? fileSize / elapsed : 0,
                startTime,
              });
            }
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: data.description || 'Failed to send' });
          }
        } catch {
          resolve({ ok: false, error: 'Invalid response from Telegram' });
        }
      });

      xhr.addEventListener('error', () => {
        if (aborted) {
          resolve({ ok: false, error: 'Upload cancelled' });
          return;
        }
        resolve({ ok: false, error: 'Network error during upload' });
      });

      xhr.addEventListener('timeout', () => {
        resolve({ ok: false, error: 'Upload timed out' });
      });

      xhr.addEventListener('abort', () => {
        resolve({ ok: false, error: 'Upload cancelled' });
      });

      xhr.open('POST', `${API_BASE}${botToken}/${endpoint}`);
      xhr.timeout = 300000;
      xhr.send(formData);
    } catch (e: any) {
      resolve({ ok: false, error: e.message || 'Network error' });
    }
  });

  const abort = () => {
    aborted = true;
    if (xhrInstance) {
      try {
        xhrInstance.abort();
      } catch {
        // ignore
      }
    }
  };

  return { promise, abort };
}

export function delay(ms: number): Promise<void> & { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout>;
  let rejectFn: () => void;

  const promise = new Promise<void>((resolve, reject) => {
    rejectFn = reject;
    timeoutId = setTimeout(resolve, ms);
  }) as Promise<void> & { cancel: () => void };

  promise.cancel = () => {
    clearTimeout(timeoutId);
    rejectFn();
  };

  return promise;
}

export function cancellableDelay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout>;
  let resolveFn: () => void;

  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    timeoutId = setTimeout(resolve, ms);
  });

  return {
    promise,
    cancel: () => {
      clearTimeout(timeoutId);
      resolveFn(); // resolve immediately so the loop can check cancelRef
    },
  };
}
