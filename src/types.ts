export interface MediaItem {
  id: string;
  file: File;
  caption: string;
  previewUrl: string;
  type: 'photo' | 'video';
  status: 'pending' | 'uploading' | 'success' | 'error';
  errorMessage?: string;
  order: number;
}

export interface TelegramSettings {
  botToken: string;
  channelId: string;
  delayBetweenPosts: number; // seconds
}

export type PublishState = 'idle' | 'publishing' | 'paused' | 'done';
