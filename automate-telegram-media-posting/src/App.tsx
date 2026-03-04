import { useState, useRef, useCallback, useEffect } from 'react';
import { MediaItem, TelegramSettings, PublishState } from './types';
import { testBotConnection, sendMediaToTelegram, delay } from './telegramApi';
import {
  Upload, Image, Film, X, Send, Settings, CheckCircle, AlertCircle,
  Loader2, Pause, Play, RotateCcw, Trash2, GripVertical, Bot,
  Hash, Clock, FileWarning, Plus, Zap
} from 'lucide-react';

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getMediaType(file: File): 'photo' | 'video' {
  return file.type.startsWith('video/') ? 'video' : 'photo';
}

export default function App() {
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [settings, setSettings] = useState<TelegramSettings>(() => {
    const saved = localStorage.getItem('tg-publisher-settings');
    if (saved) {
      try { return JSON.parse(saved); } catch { }
    }
    return { botToken: '', channelId: '', delayBetweenPosts: 3 };
  });
  const [showSettings, setShowSettings] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>('idle');
  const [currentPublishIndex, setCurrentPublishIndex] = useState(0);
  const [botInfo, setBotInfo] = useState<{ username: string } | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [dragOverZone, setDragOverZone] = useState(false);
  const [globalCaption, setGlobalCaption] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pauseRef = useRef(false);
  const cancelRef = useRef(false);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem('tg-publisher-settings', JSON.stringify(settings));
  }, [settings]);

  // Auto-show settings if not configured
  useEffect(() => {
    if (!settings.botToken || !settings.channelId) {
      setShowSettings(true);
    }
  }, []);

  const handleTestConnection = async () => {
    if (!settings.botToken) return;
    setTestingConnection(true);
    setConnectionError('');
    const result = await testBotConnection(settings.botToken);
    setTestingConnection(false);
    if (result.ok && result.username) {
      setBotInfo({ username: result.username });
      setConnectionError('');
    } else {
      setBotInfo(null);
      setConnectionError(result.error || 'Connection failed');
    }
  };

  const handleFilesSelected = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const validFiles = fileArray.filter(f =>
      f.type.startsWith('image/') || f.type.startsWith('video/')
    );

    if (validFiles.length === 0) return;

    const newItems: MediaItem[] = validFiles.map((file, i) => ({
      id: generateId(),
      file,
      caption: '',
      previewUrl: URL.createObjectURL(file),
      type: getMediaType(file),
      status: 'pending' as const,
      order: mediaItems.length + i,
    }));

    setMediaItems(prev => [...prev, ...newItems]);
  }, [mediaItems.length]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOverZone(false);
    if (e.dataTransfer.files.length > 0) {
      handleFilesSelected(e.dataTransfer.files);
    }
  }, [handleFilesSelected]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOverZone(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOverZone(false);
  }, []);

  const removeItem = (id: string) => {
    setMediaItems(prev => {
      const item = prev.find(m => m.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter(m => m.id !== id);
    });
  };

  const updateCaption = (id: string, caption: string) => {
    setMediaItems(prev => prev.map(m => m.id === id ? { ...m, caption } : m));
  };

  const clearAll = () => {
    mediaItems.forEach(m => URL.revokeObjectURL(m.previewUrl));
    setMediaItems([]);
    setPublishState('idle');
    setCurrentPublishIndex(0);
  };

  const applyGlobalCaption = () => {
    if (!globalCaption.trim()) return;
    setMediaItems(prev => prev.map(m => ({
      ...m,
      caption: m.caption ? m.caption : globalCaption
    })));
  };

  const applyGlobalCaptionToAll = () => {
    if (!globalCaption.trim()) return;
    setMediaItems(prev => prev.map(m => ({ ...m, caption: globalCaption })));
  };

  // Drag and drop reorder
  const handleDragStart = (index: number) => {
    dragItem.current = index;
  };

  const handleDragEnter = (index: number) => {
    dragOverItem.current = index;
  };

  const handleDragEnd = () => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    const items = [...mediaItems];
    const draggedItem = items[dragItem.current];
    items.splice(dragItem.current, 1);
    items.splice(dragOverItem.current, 0, draggedItem);
    dragItem.current = null;
    dragOverItem.current = null;
    setMediaItems(items);
  };

  // Publishing
  const startPublishing = async () => {
    if (!settings.botToken || !settings.channelId) {
      setShowSettings(true);
      return;
    }

    const pendingItems = mediaItems.filter(m => m.status === 'pending' || m.status === 'error');
    if (pendingItems.length === 0) return;

    setPublishState('publishing');
    pauseRef.current = false;
    cancelRef.current = false;

    for (let i = 0; i < mediaItems.length; i++) {
      if (cancelRef.current) {
        setPublishState('idle');
        return;
      }

      // Check if this item needs to be published
      const currentItem = mediaItems[i];
      if (currentItem.status === 'success') continue;

      // Wait while paused
      while (pauseRef.current) {
        await delay(200);
        if (cancelRef.current) {
          setPublishState('idle');
          return;
        }
      }

      setCurrentPublishIndex(i);
      
      // Set uploading
      setMediaItems(prev => prev.map((m, idx) => idx === i ? { ...m, status: 'uploading' as const } : m));

      const result = await sendMediaToTelegram(settings.botToken, settings.channelId, mediaItems[i]);

      if (cancelRef.current) {
        setMediaItems(prev => prev.map((m, idx) => idx === i ? { ...m, status: 'pending' as const } : m));
        setPublishState('idle');
        return;
      }

      if (result.ok) {
        setMediaItems(prev => prev.map((m, idx) => idx === i ? { ...m, status: 'success' as const } : m));
      } else {
        setMediaItems(prev => prev.map((m, idx) => idx === i ? { ...m, status: 'error' as const, errorMessage: result.error } : m));
      }

      // Delay between posts
      if (i < mediaItems.length - 1) {
        const delayMs = settings.delayBetweenPosts * 1000;
        await delay(delayMs);
      }
    }

    setPublishState('done');
  };

  const pausePublishing = () => {
    pauseRef.current = true;
    setPublishState('paused');
  };

  const resumePublishing = () => {
    pauseRef.current = false;
    setPublishState('publishing');
  };

  const cancelPublishing = () => {
    cancelRef.current = true;
    pauseRef.current = false;
  };

  const resetStatuses = () => {
    setMediaItems(prev => prev.map(m => ({ ...m, status: 'pending' as const, errorMessage: undefined })));
    setPublishState('idle');
    setCurrentPublishIndex(0);
  };

  const successCount = mediaItems.filter(m => m.status === 'success').length;
  const errorCount = mediaItems.filter(m => m.status === 'error').length;
  const pendingCount = mediaItems.filter(m => m.status === 'pending').length;
  const photoCount = mediaItems.filter(m => m.type === 'photo').length;
  const videoCount = mediaItems.filter(m => m.type === 'video').length;

  const isConfigured = settings.botToken.trim() !== '' && settings.channelId.trim() !== '';

  return (
    <div className="min-h-screen bg-tg-darker">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-tg-dark/95 backdrop-blur-sm border-b border-tg-border">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-tg-blue rounded-xl flex items-center justify-center">
              <Send className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-tg-text">Telegram Publisher</h1>
              <p className="text-xs text-tg-muted">Публикация медиа в Telegram каналы</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {botInfo && (
              <div className="hidden sm:flex items-center gap-2 bg-tg-success/10 text-tg-success px-3 py-1.5 rounded-lg text-sm">
                <Bot className="w-4 h-4" />
                @{botInfo.username}
              </div>
            )}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                showSettings
                  ? 'bg-tg-blue text-white'
                  : isConfigured
                  ? 'bg-tg-card text-tg-text hover:bg-tg-hover border border-tg-border'
                  : 'bg-tg-warning/20 text-tg-warning border border-tg-warning/30 animate-pulse'
              }`}
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Настройки</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Settings Panel */}
        {showSettings && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-6 animate-slide-up">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-tg-text flex items-center gap-2">
                <Settings className="w-5 h-5 text-tg-blue" />
                Настройки Telegram
              </h2>
              <button onClick={() => setShowSettings(false)} className="text-tg-muted hover:text-tg-text transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-tg-muted mb-2 flex items-center gap-2">
                    <Bot className="w-4 h-4" />
                    Bot Token
                  </label>
                  <input
                    type="password"
                    value={settings.botToken}
                    onChange={e => setSettings(s => ({ ...s, botToken: e.target.value }))}
                    placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                    className="w-full bg-tg-darker border border-tg-border rounded-xl px-4 py-3 text-sm text-tg-text placeholder-tg-muted/50 focus:outline-none focus:border-tg-blue focus:ring-1 focus:ring-tg-blue/30 transition-all"
                  />
                  <p className="text-xs text-tg-muted mt-1.5">Получите у @BotFather в Telegram</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-tg-muted mb-2 flex items-center gap-2">
                    <Hash className="w-4 h-4" />
                    ID канала или @username
                  </label>
                  <input
                    type="text"
                    value={settings.channelId}
                    onChange={e => setSettings(s => ({ ...s, channelId: e.target.value }))}
                    placeholder="@mychannel или -1001234567890"
                    className="w-full bg-tg-darker border border-tg-border rounded-xl px-4 py-3 text-sm text-tg-text placeholder-tg-muted/50 focus:outline-none focus:border-tg-blue focus:ring-1 focus:ring-tg-blue/30 transition-all"
                  />
                  <p className="text-xs text-tg-muted mt-1.5">Бот должен быть администратором канала</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-tg-muted mb-2 flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    Задержка между постами (сек)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={settings.delayBetweenPosts}
                    onChange={e => setSettings(s => ({ ...s, delayBetweenPosts: Math.max(1, parseInt(e.target.value) || 3) }))}
                    className="w-full bg-tg-darker border border-tg-border rounded-xl px-4 py-3 text-sm text-tg-text focus:outline-none focus:border-tg-blue focus:ring-1 focus:ring-tg-blue/30 transition-all"
                  />
                  <p className="text-xs text-tg-muted mt-1.5">Рекомендуется не менее 3 секунд</p>
                </div>

                <div className="pt-2">
                  <button
                    onClick={handleTestConnection}
                    disabled={!settings.botToken || testingConnection}
                    className="w-full flex items-center justify-center gap-2 bg-tg-blue/10 hover:bg-tg-blue/20 text-tg-blue border border-tg-blue/30 rounded-xl px-4 py-3 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {testingConnection ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Zap className="w-4 h-4" />
                    )}
                    Проверить подключение
                  </button>
                  {connectionError && (
                    <p className="text-xs text-tg-error mt-2 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {connectionError}
                    </p>
                  )}
                  {botInfo && (
                    <p className="text-xs text-tg-success mt-2 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      Подключено к @{botInfo.username}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Upload Zone */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => publishState === 'idle' && fileInputRef.current?.click()}
          className={`relative border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all ${
            dragOverZone
              ? 'upload-zone-active border-tg-blue bg-tg-blue/5'
              : 'border-tg-border hover:border-tg-muted bg-tg-card/50 hover:bg-tg-card'
          } ${publishState !== 'idle' ? 'opacity-50 pointer-events-none' : ''}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*"
            onChange={e => e.target.files && handleFilesSelected(e.target.files)}
            className="hidden"
          />
          <div className="flex flex-col items-center gap-4">
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${
              dragOverZone ? 'bg-tg-blue/20' : 'bg-tg-darker'
            }`}>
              <Upload className={`w-8 h-8 ${dragOverZone ? 'text-tg-blue' : 'text-tg-muted'}`} />
            </div>
            <div>
              <p className="text-lg font-medium text-tg-text mb-1">
                {dragOverZone ? 'Отпустите файлы сюда' : 'Перетащите файлы сюда'}
              </p>
              <p className="text-sm text-tg-muted">
                или нажмите для выбора • Фото и видео • Несколько файлов
              </p>
            </div>
            <div className="flex items-center gap-6 text-tg-muted">
              <span className="flex items-center gap-1.5 text-xs">
                <Image className="w-4 h-4" /> JPG, PNG, GIF, WebP
              </span>
              <span className="flex items-center gap-1.5 text-xs">
                <Film className="w-4 h-4" /> MP4, MOV, AVI
              </span>
            </div>
          </div>
        </div>

        {/* Global Caption */}
        {mediaItems.length > 0 && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-5 animate-slide-up">
            <label className="block text-sm font-medium text-tg-muted mb-3">
              📝 Общая подпись для всех файлов
            </label>
            <div className="flex gap-3">
              <textarea
                value={globalCaption}
                onChange={e => setGlobalCaption(e.target.value)}
                placeholder="Введите подпись, которую хотите применить ко всем файлам..."
                rows={2}
                className="flex-1 bg-tg-darker border border-tg-border rounded-xl px-4 py-3 text-sm text-tg-text placeholder-tg-muted/50 focus:outline-none focus:border-tg-blue focus:ring-1 focus:ring-tg-blue/30 transition-all resize-none"
              />
              <div className="flex flex-col gap-2">
                <button
                  onClick={applyGlobalCaption}
                  className="px-4 py-2 bg-tg-blue/10 text-tg-blue border border-tg-blue/30 rounded-xl text-xs font-medium hover:bg-tg-blue/20 transition-all whitespace-nowrap"
                >
                  К пустым
                </button>
                <button
                  onClick={applyGlobalCaptionToAll}
                  className="px-4 py-2 bg-tg-warning/10 text-tg-warning border border-tg-warning/30 rounded-xl text-xs font-medium hover:bg-tg-warning/20 transition-all whitespace-nowrap"
                >
                  Ко всем
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Stats Bar */}
        {mediaItems.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-4 bg-tg-card rounded-2xl border border-tg-border px-5 py-4">
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-sm text-tg-text font-medium">
                Всего: <span className="text-tg-blue">{mediaItems.length}</span>
              </span>
              {photoCount > 0 && (
                <span className="flex items-center gap-1 text-sm text-tg-muted">
                  <Image className="w-3.5 h-3.5" /> {photoCount} фото
                </span>
              )}
              {videoCount > 0 && (
                <span className="flex items-center gap-1 text-sm text-tg-muted">
                  <Film className="w-3.5 h-3.5" /> {videoCount} видео
                </span>
              )}
              {successCount > 0 && (
                <span className="flex items-center gap-1 text-sm text-tg-success">
                  <CheckCircle className="w-3.5 h-3.5" /> {successCount}
                </span>
              )}
              {errorCount > 0 && (
                <span className="flex items-center gap-1 text-sm text-tg-error">
                  <AlertCircle className="w-3.5 h-3.5" /> {errorCount}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {publishState === 'done' && (
                <button
                  onClick={resetStatuses}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-tg-blue/10 text-tg-blue rounded-lg text-sm hover:bg-tg-blue/20 transition-all"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Сбросить
                </button>
              )}
              <button
                onClick={clearAll}
                disabled={publishState === 'publishing'}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-tg-error/10 text-tg-error rounded-lg text-sm hover:bg-tg-error/20 transition-all disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Очистить
              </button>
            </div>
          </div>
        )}

        {/* Progress Bar */}
        {(publishState === 'publishing' || publishState === 'paused') && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-tg-text">
                {publishState === 'paused' ? '⏸️ Приостановлено' : '📤 Публикация...'}
              </span>
              <span className="text-sm text-tg-muted">
                {successCount + errorCount} / {mediaItems.length}
              </span>
            </div>
            <div className="h-2 bg-tg-darker rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-tg-blue to-blue-400 rounded-full transition-all duration-500 animate-progress"
                style={{ width: `${((successCount + errorCount) / mediaItems.length) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Media Grid */}
        {mediaItems.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {mediaItems.map((item, index) => (
              <div
                key={item.id}
                draggable={publishState === 'idle'}
                onDragStart={() => handleDragStart(index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragEnd={handleDragEnd}
                onDragOver={e => e.preventDefault()}
                className={`group bg-tg-card rounded-2xl border overflow-hidden transition-all animate-slide-up ${
                  item.status === 'success'
                    ? 'border-tg-success/40'
                    : item.status === 'error'
                    ? 'border-tg-error/40'
                    : item.status === 'uploading'
                    ? 'border-tg-blue/40'
                    : 'border-tg-border hover:border-tg-muted'
                }`}
              >
                {/* Preview */}
                <div className="relative aspect-video bg-tg-darker overflow-hidden">
                  {item.type === 'photo' ? (
                    <img
                      src={item.previewUrl}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <video
                      src={item.previewUrl}
                      className="w-full h-full object-cover"
                      muted
                      preload="metadata"
                      onLoadedMetadata={e => {
                        const video = e.target as HTMLVideoElement;
                        video.currentTime = 1;
                      }}
                    />
                  )}

                  {/* Overlay badges */}
                  <div className="absolute top-2 left-2 flex items-center gap-2">
                    <span className={`px-2 py-1 rounded-lg text-xs font-medium backdrop-blur-sm ${
                      item.type === 'photo'
                        ? 'bg-tg-blue/80 text-white'
                        : 'bg-purple-600/80 text-white'
                    }`}>
                      {item.type === 'photo' ? '📷 Фото' : '🎬 Видео'}
                    </span>
                    <span className="px-2 py-1 rounded-lg text-xs bg-black/50 text-white backdrop-blur-sm">
                      #{index + 1}
                    </span>
                  </div>

                  {/* Status overlay */}
                  {item.status === 'uploading' && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center backdrop-blur-sm">
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-8 h-8 text-tg-blue animate-spin" />
                        <span className="text-sm text-white font-medium">Отправка...</span>
                      </div>
                    </div>
                  )}
                  {item.status === 'success' && (
                    <div className="absolute inset-0 bg-tg-success/20 flex items-center justify-center">
                      <CheckCircle className="w-12 h-12 text-tg-success" />
                    </div>
                  )}
                  {item.status === 'error' && (
                    <div className="absolute inset-0 bg-tg-error/20 flex items-center justify-center backdrop-blur-sm">
                      <div className="flex flex-col items-center gap-2 px-4 text-center">
                        <AlertCircle className="w-8 h-8 text-tg-error" />
                        <span className="text-xs text-tg-error">{item.errorMessage}</span>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  {publishState === 'idle' && (
                    <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); removeItem(item.id); }}
                        className="w-8 h-8 bg-tg-error/80 hover:bg-tg-error text-white rounded-lg flex items-center justify-center backdrop-blur-sm transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  {/* Drag handle */}
                  {publishState === 'idle' && (
                    <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing">
                      <div className="w-8 h-8 bg-black/50 backdrop-blur-sm rounded-lg flex items-center justify-center text-white/70 hover:text-white">
                        <GripVertical className="w-4 h-4" />
                      </div>
                    </div>
                  )}
                </div>

                {/* Caption & Info */}
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-tg-muted truncate flex-1 mr-2" title={item.file.name}>
                      {item.file.name}
                    </p>
                    <span className="text-xs text-tg-muted whitespace-nowrap">
                      {formatFileSize(item.file.size)}
                    </span>
                  </div>
                  <textarea
                    value={item.caption}
                    onChange={e => updateCaption(item.id, e.target.value)}
                    placeholder="Подпись к публикации..."
                    rows={2}
                    disabled={publishState !== 'idle'}
                    className="w-full bg-tg-darker border border-tg-border rounded-xl px-3 py-2 text-sm text-tg-text placeholder-tg-muted/50 focus:outline-none focus:border-tg-blue focus:ring-1 focus:ring-tg-blue/30 transition-all resize-none disabled:opacity-50"
                  />
                </div>
              </div>
            ))}

            {/* Add More Button */}
            {publishState === 'idle' && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-tg-border rounded-2xl flex flex-col items-center justify-center gap-3 min-h-[250px] hover:border-tg-muted hover:bg-tg-card/50 transition-all group"
              >
                <div className="w-14 h-14 rounded-2xl bg-tg-card border border-tg-border flex items-center justify-center group-hover:border-tg-muted transition-colors">
                  <Plus className="w-6 h-6 text-tg-muted group-hover:text-tg-text transition-colors" />
                </div>
                <span className="text-sm text-tg-muted group-hover:text-tg-text transition-colors">
                  Добавить ещё
                </span>
              </button>
            )}
          </div>
        )}

        {/* Empty State */}
        {mediaItems.length === 0 && (
          <div className="text-center py-16">
            <div className="w-20 h-20 bg-tg-card rounded-3xl flex items-center justify-center mx-auto mb-6 border border-tg-border">
              <FileWarning className="w-10 h-10 text-tg-muted" />
            </div>
            <h3 className="text-xl font-semibold text-tg-text mb-2">Нет загруженных файлов</h3>
            <p className="text-tg-muted max-w-md mx-auto">
              Загрузите фото или видео выше, добавьте подписи и опубликуйте в свой Telegram канал одним нажатием
            </p>
          </div>
        )}

        {/* Publish Button */}
        {mediaItems.length > 0 && (
          <div className="sticky bottom-6 z-40">
            <div className="bg-tg-dark/95 backdrop-blur-md rounded-2xl border border-tg-border p-4 shadow-2xl shadow-black/50">
              <div className="flex items-center justify-between gap-4">
                <div className="text-sm text-tg-muted">
                  {publishState === 'done' ? (
                    <span className="text-tg-success flex items-center gap-1.5">
                      <CheckCircle className="w-4 h-4" />
                      Готово! Опубликовано {successCount} из {mediaItems.length}
                      {errorCount > 0 && <span className="text-tg-error">, ошибок: {errorCount}</span>}
                    </span>
                  ) : publishState === 'publishing' ? (
                    <span className="text-tg-blue flex items-center gap-1.5">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Публикация {currentPublishIndex + 1} из {mediaItems.length}...
                    </span>
                  ) : publishState === 'paused' ? (
                    <span className="text-tg-warning flex items-center gap-1.5">
                      <Pause className="w-4 h-4" />
                      Пауза
                    </span>
                  ) : (
                    <span>
                      {!isConfigured ? '⚠️ Настройте бота для начала' : `Готово к публикации: ${pendingCount} файлов`}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {publishState === 'idle' && (
                    <button
                      onClick={startPublishing}
                      disabled={!isConfigured || pendingCount === 0}
                      className="flex items-center gap-2 px-6 py-3 bg-tg-blue hover:bg-tg-blue/90 text-white rounded-xl font-medium text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-tg-blue/20"
                    >
                      <Send className="w-4 h-4" />
                      Опубликовать
                    </button>
                  )}
                  {publishState === 'publishing' && (
                    <>
                      <button
                        onClick={pausePublishing}
                        className="flex items-center gap-2 px-4 py-3 bg-tg-warning/20 text-tg-warning rounded-xl font-medium text-sm hover:bg-tg-warning/30 transition-all"
                      >
                        <Pause className="w-4 h-4" />
                        Пауза
                      </button>
                      <button
                        onClick={cancelPublishing}
                        className="flex items-center gap-2 px-4 py-3 bg-tg-error/20 text-tg-error rounded-xl font-medium text-sm hover:bg-tg-error/30 transition-all"
                      >
                        <X className="w-4 h-4" />
                        Отмена
                      </button>
                    </>
                  )}
                  {publishState === 'paused' && (
                    <>
                      <button
                        onClick={resumePublishing}
                        className="flex items-center gap-2 px-4 py-3 bg-tg-blue hover:bg-tg-blue/90 text-white rounded-xl font-medium text-sm transition-all"
                      >
                        <Play className="w-4 h-4" />
                        Продолжить
                      </button>
                      <button
                        onClick={cancelPublishing}
                        className="flex items-center gap-2 px-4 py-3 bg-tg-error/20 text-tg-error rounded-xl font-medium text-sm hover:bg-tg-error/30 transition-all"
                      >
                        <X className="w-4 h-4" />
                        Отмена
                      </button>
                    </>
                  )}
                  {publishState === 'done' && (
                    <button
                      onClick={resetStatuses}
                      className="flex items-center gap-2 px-6 py-3 bg-tg-blue hover:bg-tg-blue/90 text-white rounded-xl font-medium text-sm transition-all"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Заново
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Instructions */}
        {mediaItems.length === 0 && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-6 mt-8">
            <h3 className="text-base font-semibold text-tg-text mb-4">📖 Как пользоваться</h3>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { step: '1', title: 'Создайте бота', desc: 'Зайдите в @BotFather и создайте нового бота. Скопируйте токен.' },
                { step: '2', title: 'Добавьте бота', desc: 'Добавьте бота администратором в ваш Telegram канал.' },
                { step: '3', title: 'Загрузите медиа', desc: 'Перетащите или выберите фото и видео. Добавьте подписи.' },
                { step: '4', title: 'Публикуйте', desc: 'Нажмите "Опубликовать" и все файлы будут отправлены по очереди.' },
              ].map(item => (
                <div key={item.step} className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg bg-tg-blue/10 text-tg-blue flex items-center justify-center text-sm font-bold shrink-0">
                    {item.step}
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-tg-text">{item.title}</h4>
                    <p className="text-xs text-tg-muted mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
