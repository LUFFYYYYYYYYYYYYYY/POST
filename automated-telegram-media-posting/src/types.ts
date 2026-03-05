export interface UploadProgress {
  loaded: number;    // bytes uploaded
  total: number;     // total bytes
  percent: number;   // 0-100
  speed: number;     // bytes per second
  startTime: number; // timestamp when upload started
}

export interface MediaItem {
  id: string;
  file: File;
  caption: string;
  previewUrl: string;
  type: 'photo' | 'video';
  status: 'pending' | 'uploading' | 'success' | 'error';
  errorMessage?: string;
  order: number;
  uploadProgress?: UploadProgress;
}

export interface TelegramSettings {
  botToken: string;
  channelId: string;
  delayBetweenPosts: number; // seconds (normal mode)
  turboMode: boolean;
  turboDelayMs: number; // milliseconds (turbo mode)
  parallelUploads: number; // how many files to send simultaneously
}

export type PublishState = 'idle' | 'publishing' | 'paused' | 'done';
