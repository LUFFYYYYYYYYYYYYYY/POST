import { MediaItem } from './types';

const API_BASE = 'https://api.telegram.org/bot';

export async function testBotConnection(botToken: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}${botToken}/getMe`);
    const data = await res.json();
    if (data.ok) {
      return { ok: true, username: data.result.username };
    }
    return { ok: false, error: data.description || 'Unknown error' };
  } catch (e) {
    return { ok: false, error: 'Network error. Check your internet connection.' };
  }
}

export async function sendMediaToTelegram(
  botToken: string,
  channelId: string,
  item: MediaItem,
  parseMode?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
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

    const res = await fetch(`${API_BASE}${botToken}/${endpoint}`, {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();

    if (data.ok) {
      return { ok: true };
    }

    return { ok: false, error: data.description || 'Failed to send' };
  } catch (e: any) {
    return { ok: false, error: e.message || 'Network error' };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
