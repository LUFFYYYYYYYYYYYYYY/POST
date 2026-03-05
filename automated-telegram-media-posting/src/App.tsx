import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { MediaItem, TelegramSettings, PublishState, UploadProgress } from './types';
import { testBotConnection, sendMediaToTelegram, cancellableDelay, SendMediaHandle } from './telegramApi';
import { useTelegramWebApp } from './hooks/useTelegramWebApp';
import {
  Upload, Image, Film, X, Send, Settings, CheckCircle, AlertCircle,
  Loader2, Pause, Play, RotateCcw, Trash2, GripVertical, Bot,
  Hash, Clock, FileWarning, Plus, Zap, Layers, ArrowUpFromLine, Gauge,
  Info, Shield
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

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return bytesPerSecond.toFixed(0) + ' B/s';
  if (bytesPerSecond < 1024 * 1024) return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
  return (bytesPerSecond / (1024 * 1024)).toFixed(1) + ' MB/s';
}

function formatETA(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '< 1с';
  if (seconds < 60) return `${Math.ceil(seconds)}с`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  if (mins < 60) return `${mins}м ${secs}с`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}ч ${remainMins}м`;
}

function getMediaType(file: File): 'photo' | 'video' {
  return file.type.startsWith('video/') ? 'video' : 'photo';
}

export default function App() {
  // === Telegram Mini App ===
  const tma = useTelegramWebApp();

  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [settings, setSettings] = useState<TelegramSettings>(() => {
    const saved = localStorage.getItem('tg-publisher-settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          botToken: parsed.botToken || '',
          channelId: parsed.channelId || '',
          delayBetweenPosts: parsed.delayBetweenPosts ?? 3,
          turboMode: parsed.turboMode ?? false,
          turboDelayMs: parsed.turboDelayMs ?? 50,
          parallelUploads: parsed.parallelUploads ?? 1,
        };
      } catch { /* ignore */ }
    }
    return { botToken: '', channelId: '', delayBetweenPosts: 3, turboMode: false, turboDelayMs: 50, parallelUploads: 1 };
  });
  const [showSettings, setShowSettings] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>('idle');
  const [botInfo, setBotInfo] = useState<{ username: string } | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [dragOverZone, setDragOverZone] = useState(false);
  const [globalCaption, setGlobalCaption] = useState('');
  const [publishStartTime, setPublishStartTime] = useState(0);
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pauseRef = useRef(false);
  const cancelRef = useRef(false);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const activeUploadsRef = useRef<SendMediaHandle[]>([]);
  const activeDelayRef = useRef<{ cancel: () => void } | null>(null);

  // === TMA: BackButton for settings ===
  useEffect(() => {
    if (!tma.isTMA || !tma.webApp) return;
    const webApp = tma.webApp;

    try {
      if (showSettings || showSetupGuide) {
        webApp.BackButton.show();
        const handler = () => {
          setShowSettings(false);
          setShowSetupGuide(false);
        };
        webApp.BackButton.onClick(handler);
        return () => {
          try { webApp.BackButton.offClick(handler); webApp.BackButton.hide(); } catch { /* */ }
        };
      } else {
        webApp.BackButton.hide();
      }
    } catch { /* BackButton not supported */ }
  }, [tma.isTMA, tma.webApp, showSettings, showSetupGuide]);

  // === TMA: Enable closing confirmation during publishing ===
  useEffect(() => {
    if (!tma.isTMA || !tma.webApp) return;
    try {
      if (publishState === 'publishing' || publishState === 'paused') {
        tma.webApp.enableClosingConfirmation();
      } else {
        tma.webApp.disableClosingConfirmation();
      }
    } catch { /* not supported */ }
  }, [tma.isTMA, tma.webApp, publishState]);

  // Save settings
  useEffect(() => {
    localStorage.setItem('tg-publisher-settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!settings.botToken || !settings.channelId) {
      setShowSettings(true);
    }
  }, []);

  const handleTestConnection = async () => {
    if (!settings.botToken) return;
    tma.haptic.impact('light');
    setTestingConnection(true);
    setConnectionError('');
    const result = await testBotConnection(settings.botToken);
    setTestingConnection(false);
    if (result.ok && result.username) {
      setBotInfo({ username: result.username });
      setConnectionError('');
      tma.haptic.notification('success');
    } else {
      setBotInfo(null);
      setConnectionError(result.error || 'Connection failed');
      tma.haptic.notification('error');
    }
  };

  const handleFilesSelected = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const validFiles = fileArray.filter(f =>
      f.type.startsWith('image/') || f.type.startsWith('video/')
    );
    if (validFiles.length === 0) return;
    tma.haptic.impact('medium');
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
  }, [mediaItems.length, tma.haptic]);

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
    tma.haptic.impact('light');
    setMediaItems(prev => {
      const item = prev.find(m => m.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter(m => m.id !== id);
    });
  };

  const updateCaption = (id: string, caption: string) => {
    setMediaItems(prev => prev.map(m => m.id === id ? { ...m, caption } : m));
  };

  const clearAll = async () => {
    const confirmed = await tma.showConfirm('Удалить все файлы?');
    if (!confirmed) return;
    tma.haptic.notification('warning');
    mediaItems.forEach(m => URL.revokeObjectURL(m.previewUrl));
    setMediaItems([]);
    setPublishState('idle');
  };

  const applyGlobalCaption = () => {
    if (!globalCaption.trim()) return;
    tma.haptic.impact('light');
    setMediaItems(prev => prev.map(m => ({
      ...m,
      caption: m.caption ? m.caption : globalCaption
    })));
  };

  const applyGlobalCaptionToAll = () => {
    if (!globalCaption.trim()) return;
    tma.haptic.impact('medium');
    setMediaItems(prev => prev.map(m => ({ ...m, caption: globalCaption })));
  };

  const handleDragStart = (index: number) => { dragItem.current = index; tma.haptic.selection(); };
  const handleDragEnter = (index: number) => { dragOverItem.current = index; };
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

  const mediaItemsRef = useRef(mediaItems);
  mediaItemsRef.current = mediaItems;

  const updateItemProgress = useCallback((index: number, progress: UploadProgress) => {
    setMediaItems(prev => prev.map((m, idx) =>
      idx === index ? { ...m, uploadProgress: progress } : m
    ));
  }, []);

  // ===== PUBLISHING =====
  const startPublishing = async () => {
    if (!settings.botToken || !settings.channelId) {
      setShowSettings(true);
      return;
    }

    const pendingItems = mediaItems.filter(m => m.status === 'pending' || m.status === 'error');
    if (pendingItems.length === 0) return;

    tma.haptic.impact('heavy');
    setPublishState('publishing');
    setPublishStartTime(Date.now());
    pauseRef.current = false;
    cancelRef.current = false;
    activeUploadsRef.current = [];

    const getDelayMs = () => {
      if (settings.turboMode) return settings.turboDelayMs;
      return settings.delayBetweenPosts * 1000;
    };

    const concurrency = settings.turboMode ? Math.max(1, settings.parallelUploads) : 1;

    const queue: number[] = [];
    for (let i = 0; i < mediaItems.length; i++) {
      if (mediaItems[i].status !== 'success') {
        queue.push(i);
      }
    }

    const waitWhilePaused = async (): Promise<boolean> => {
      while (pauseRef.current) {
        await new Promise(r => setTimeout(r, 200));
        if (cancelRef.current) return true;
      }
      return cancelRef.current;
    };

    const doDelay = async (ms: number): Promise<boolean> => {
      if (ms <= 0) return cancelRef.current;
      const d = cancellableDelay(ms);
      activeDelayRef.current = d;
      await d.promise;
      activeDelayRef.current = null;
      return cancelRef.current;
    };

    if (concurrency <= 1) {
      for (let qi = 0; qi < queue.length; qi++) {
        const i = queue[qi];
        if (cancelRef.current) break;
        if (await waitWhilePaused()) break;

        setMediaItems(prev => prev.map((m, idx) => idx === i ? {
          ...m,
          status: 'uploading' as const,
          uploadProgress: { loaded: 0, total: m.file.size, percent: 0, speed: 0, startTime: Date.now() }
        } : m));

        const itemSnapshot = mediaItemsRef.current[i];
        const handle = sendMediaToTelegram(
          settings.botToken, settings.channelId, itemSnapshot,
          (progress) => updateItemProgress(i, progress)
        );
        activeUploadsRef.current = [handle];
        const result = await handle.promise;
        activeUploadsRef.current = [];

        if (cancelRef.current) {
          setMediaItems(prev => prev.map((m, idx) =>
            idx === i ? { ...m, status: 'pending' as const, uploadProgress: undefined } : m
          ));
          break;
        }

        if (result.ok) {
          tma.haptic.notification('success');
          setMediaItems(prev => prev.map((m, idx) =>
            idx === i ? { ...m, status: 'success' as const } : m
          ));
        } else {
          tma.haptic.notification('error');
          setMediaItems(prev => prev.map((m, idx) =>
            idx === i ? { ...m, status: 'error' as const, errorMessage: result.error, uploadProgress: undefined } : m
          ));
        }

        if (qi < queue.length - 1) {
          if (await doDelay(getDelayMs())) break;
        }
      }
    } else {
      let queueIdx = 0;
      while (queueIdx < queue.length) {
        if (cancelRef.current) break;
        if (await waitWhilePaused()) break;

        const chunk = queue.slice(queueIdx, queueIdx + concurrency);

        setMediaItems(prev => prev.map((m, idx) =>
          chunk.includes(idx) ? {
            ...m,
            status: 'uploading' as const,
            uploadProgress: { loaded: 0, total: m.file.size, percent: 0, speed: 0, startTime: Date.now() }
          } : m
        ));

        const handles: { index: number; handle: SendMediaHandle }[] = chunk.map((i) => {
          const itemSnapshot = mediaItemsRef.current[i];
          const handle = sendMediaToTelegram(
            settings.botToken, settings.channelId, itemSnapshot,
            (progress) => updateItemProgress(i, progress)
          );
          return { index: i, handle };
        });

        activeUploadsRef.current = handles.map(h => h.handle);

        const results = await Promise.all(
          handles.map(async ({ index, handle }) => {
            const result = await handle.promise;
            return { index, result };
          })
        );

        activeUploadsRef.current = [];

        if (cancelRef.current) {
          setMediaItems(prev => prev.map((m, idx) =>
            chunk.includes(idx) && m.status === 'uploading'
              ? { ...m, status: 'pending' as const, uploadProgress: undefined }
              : m
          ));
          break;
        }

        results.forEach(r => {
          if (r.result.ok) tma.haptic.notification('success');
          else tma.haptic.notification('error');
        });

        setMediaItems(prev => prev.map((m, idx) => {
          const r = results.find(x => x.index === idx);
          if (!r) return m;
          if (r.result.ok) return { ...m, status: 'success' as const };
          return { ...m, status: 'error' as const, errorMessage: r.result.error, uploadProgress: undefined };
        }));

        queueIdx += concurrency;

        if (queueIdx < queue.length) {
          if (await doDelay(getDelayMs())) break;
        }
      }
    }

    if (cancelRef.current) {
      setMediaItems(prev => prev.map(m =>
        m.status === 'uploading'
          ? { ...m, status: 'pending' as const, uploadProgress: undefined }
          : m
      ));
      setPublishState('idle');
      tma.haptic.notification('warning');
    } else {
      setPublishState('done');
      tma.haptic.notification('success');
      if (tma.isTMA) {
        const allSuccess = mediaItems.every(m => m.status === 'success' || mediaItems.filter(x => x.status !== 'success').length === 0);
        if (allSuccess) {
          // Could show alert in TMA
        }
      }
    }
  };

  const pausePublishing = () => {
    pauseRef.current = true;
    setPublishState('paused');
    tma.haptic.impact('medium');
  };

  const resumePublishing = () => {
    pauseRef.current = false;
    setPublishState('publishing');
    tma.haptic.impact('medium');
  };

  const cancelPublishing = async () => {
    const confirmed = await tma.showConfirm('Остановить публикацию?');
    if (!confirmed) return;

    cancelRef.current = true;
    pauseRef.current = false;

    activeUploadsRef.current.forEach(handle => {
      try { handle.abort(); } catch { /* ignore */ }
    });
    activeUploadsRef.current = [];

    if (activeDelayRef.current) {
      try { activeDelayRef.current.cancel(); } catch { /* ignore */ }
      activeDelayRef.current = null;
    }

    tma.haptic.notification('warning');
  };

  const resetStatuses = () => {
    tma.haptic.impact('light');
    setMediaItems(prev => prev.map(m => ({ ...m, status: 'pending' as const, errorMessage: undefined, uploadProgress: undefined })));
    setPublishState('idle');
  };

  const successCount = mediaItems.filter(m => m.status === 'success').length;
  const errorCount = mediaItems.filter(m => m.status === 'error').length;
  const pendingCount = mediaItems.filter(m => m.status === 'pending').length;
  const uploadingCount = mediaItems.filter(m => m.status === 'uploading').length;
  const photoCount = mediaItems.filter(m => m.type === 'photo').length;
  const videoCount = mediaItems.filter(m => m.type === 'video').length;
  const isConfigured = settings.botToken.trim() !== '' && settings.channelId.trim() !== '';

  const uploadStats = useMemo(() => {
    const totalBytes = mediaItems.reduce((sum, m) => sum + m.file.size, 0);
    const completedBytes = mediaItems
      .filter(m => m.status === 'success')
      .reduce((sum, m) => sum + m.file.size, 0);
    const uploadingBytes = mediaItems
      .filter(m => m.status === 'uploading' && m.uploadProgress)
      .reduce((sum, m) => sum + (m.uploadProgress?.loaded || 0), 0);
    const currentLoaded = completedBytes + uploadingBytes;
    const uploadingItems = mediaItems.filter(m => m.status === 'uploading' && m.uploadProgress);
    const totalSpeed = uploadingItems.reduce((sum, m) => sum + (m.uploadProgress?.speed || 0), 0);
    const remaining = totalBytes - currentLoaded;
    const eta = totalSpeed > 0 ? remaining / totalSpeed : 0;
    const overallPercent = totalBytes > 0 ? (currentLoaded / totalBytes) * 100 : 0;
    return { totalBytes, currentLoaded, totalSpeed, eta, overallPercent };
  }, [mediaItems]);

  return (
    <div className="min-h-screen bg-tg-darker">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-tg-dark/95 backdrop-blur-sm border-b border-tg-border">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-9 h-9 sm:w-10 sm:h-10 bg-tg-blue rounded-xl flex items-center justify-center shrink-0">
              <Send className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-bold text-tg-text truncate flex items-center gap-2">
                TG Publisher
                {tma.isTMA && (
                  <span className="text-[9px] px-1.5 py-0.5 bg-tg-blue/20 text-tg-blue rounded-md font-medium uppercase tracking-wider">
                    Mini App
                  </span>
                )}
              </h1>
              {tma.isTMA && tma.user && (
                <p className="text-[10px] sm:text-xs text-tg-muted">
                  👋 {tma.user.first_name}{tma.user.last_name ? ` ${tma.user.last_name}` : ''}
                </p>
              )}
              {!tma.isTMA && (
                <p className="text-[10px] sm:text-xs text-tg-muted hidden sm:block">Публикация медиа в Telegram</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {settings.turboMode && (
              <div className="hidden sm:flex items-center gap-1.5 bg-orange-500/10 text-orange-400 px-2.5 py-1.5 rounded-lg text-xs font-medium animate-pulse">
                <Zap className="w-3.5 h-3.5" />
                TURBO
              </div>
            )}
            {botInfo && (
              <div className="hidden md:flex items-center gap-1.5 bg-tg-success/10 text-tg-success px-2.5 py-1.5 rounded-lg text-xs">
                <Bot className="w-3.5 h-3.5" />
                @{botInfo.username}
              </div>
            )}
            {tma.isTMA && (
              <button
                onClick={() => { tma.haptic.impact('light'); setShowSetupGuide(!showSetupGuide); }}
                className="flex items-center gap-1.5 px-3 py-2 bg-tg-card text-tg-muted hover:text-tg-text border border-tg-border rounded-xl text-xs font-medium hover:bg-tg-hover transition-all"
              >
                <Info className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => { tma.haptic.impact('light'); setShowSettings(!showSettings); }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs sm:text-sm font-medium transition-all ${
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

      <main className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6 pb-32">

        {/* TMA Welcome Banner */}
        {tma.isTMA && !isConfigured && mediaItems.length === 0 && (
          <div className="bg-gradient-to-br from-tg-blue/10 via-tg-card to-purple-500/10 rounded-2xl border border-tg-blue/30 p-5 sm:p-6 animate-slide-up tma-glow">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-tg-blue/20 rounded-2xl flex items-center justify-center shrink-0">
                <Send className="w-6 h-6 text-tg-blue" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-bold text-tg-text mb-1">
                  Добро пожаловать{tma.user ? `, ${tma.user.first_name}` : ''}! 👋
                </h2>
                <p className="text-sm text-tg-muted mb-4">
                  Это Telegram Mini App для массовой публикации фото и видео в ваши каналы.
                  Настройте бота и начните публиковать прямо отсюда!
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => { tma.haptic.impact('light'); setShowSettings(true); }}
                    className="flex items-center gap-2 px-4 py-2.5 bg-tg-blue text-white rounded-xl text-sm font-medium hover:bg-tg-blue/90 transition-all"
                  >
                    <Settings className="w-4 h-4" />
                    Настроить бота
                  </button>
                  <button
                    onClick={() => { tma.haptic.impact('light'); setShowSetupGuide(true); }}
                    className="flex items-center gap-2 px-4 py-2.5 bg-tg-card text-tg-text border border-tg-border rounded-xl text-sm font-medium hover:bg-tg-hover transition-all"
                  >
                    <Info className="w-4 h-4" />
                    Как подключить?
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Setup Guide (TMA specific) */}
        {showSetupGuide && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-4 sm:p-6 animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base sm:text-lg font-semibold text-tg-text flex items-center gap-2">
                <Info className="w-5 h-5 text-tg-blue" />
                Инструкция по настройке
              </h2>
              <button onClick={() => setShowSetupGuide(false)} className="text-tg-muted hover:text-tg-text p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {[
                {
                  step: '1',
                  icon: '🤖',
                  title: 'Создайте бота',
                  desc: 'Откройте @BotFather → отправьте /newbot → следуйте инструкциям → скопируйте токен бота',
                  action: tma.isTMA ? () => { tma.webApp?.openTelegramLink('https://t.me/BotFather'); } : undefined,
                  actionText: 'Открыть @BotFather'
                },
                {
                  step: '2',
                  icon: '📢',
                  title: 'Добавьте бота в канал',
                  desc: 'Откройте ваш канал → Настройки → Администраторы → Добавить бота → Дайте право "Публикация сообщений"',
                },
                {
                  step: '3',
                  icon: '⚙️',
                  title: 'Введите данные',
                  desc: 'Нажмите ⚙️ Настройки → вставьте Bot Token и ID/username канала (@mychannel)',
                  action: () => { setShowSettings(true); setShowSetupGuide(false); },
                  actionText: 'Открыть настройки'
                },
                {
                  step: '4',
                  icon: '📤',
                  title: 'Загружайте и публикуйте!',
                  desc: 'Добавьте фото/видео, напишите подписи и нажмите "Опубликовать" — всё отправится автоматически',
                },
              ].map(item => (
                <div key={item.step} className="flex gap-3 bg-tg-darker rounded-xl p-3 sm:p-4">
                  <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-tg-blue/10 text-tg-blue flex items-center justify-center text-lg shrink-0">
                    {item.icon}
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-medium text-tg-text mb-0.5">
                      <span className="text-tg-blue mr-1">#{item.step}</span>
                      {item.title}
                    </h4>
                    <p className="text-xs text-tg-muted">{item.desc}</p>
                    {item.action && (
                      <button
                        onClick={item.action}
                        className="mt-2 text-xs text-tg-blue hover:underline flex items-center gap-1"
                      >
                        {item.actionText} →
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {tma.isTMA && (
                <div className="bg-tg-blue/5 border border-tg-blue/20 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-tg-blue mb-2 flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    Как привязать это приложение к боту
                  </h4>
                  <div className="text-xs text-tg-muted space-y-1.5">
                    <p>1. Откройте @BotFather → отправьте <code className="px-1.5 py-0.5 bg-tg-darker rounded text-tg-text">/newapp</code></p>
                    <p>2. Выберите вашего бота</p>
                    <p>3. Введите название и описание</p>
                    <p>4. Загрузите фото (640×360)</p>
                    <p>5. Укажите URL вашего приложения</p>
                    <p>6. Отправьте <code className="px-1.5 py-0.5 bg-tg-darker rounded text-tg-text">/setmenubutton</code> — чтобы кнопка Web App была при входе в бота</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Settings Panel */}
        {showSettings && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-4 sm:p-6 animate-slide-up">
            <div className="flex items-center justify-between mb-4 sm:mb-6">
              <h2 className="text-base sm:text-lg font-semibold text-tg-text flex items-center gap-2">
                <Settings className="w-5 h-5 text-tg-blue" />
                Настройки
              </h2>
              <button onClick={() => setShowSettings(false)} className="text-tg-muted hover:text-tg-text transition-colors p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid md:grid-cols-2 gap-4 sm:gap-6">
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
                  <p className="text-xs text-tg-muted mt-1.5 flex items-center gap-1">
                    Получите у @BotFather
                    {tma.isTMA && (
                      <button
                        onClick={() => tma.webApp?.openTelegramLink('https://t.me/BotFather')}
                        className="text-tg-blue hover:underline ml-1"
                      >
                        (открыть)
                      </button>
                    )}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-tg-muted mb-2 flex items-center gap-2">
                    <Hash className="w-4 h-4" />
                    ID канала / @username
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
                {/* Turbo Mode */}
                <div>
                  <button
                    onClick={() => { tma.haptic.selection(); setSettings(s => ({ ...s, turboMode: !s.turboMode })); }}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition-all border ${
                      settings.turboMode
                        ? 'bg-gradient-to-r from-orange-500/20 to-red-500/20 border-orange-500/50 text-orange-400'
                        : 'bg-tg-darker border-tg-border text-tg-muted hover:border-tg-muted'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Zap className={`w-4 h-4 ${settings.turboMode ? 'animate-pulse' : ''}`} />
                      ⚡ TURBO режим
                    </span>
                    <span className={`w-10 h-6 rounded-full relative transition-all ${
                      settings.turboMode ? 'bg-orange-500' : 'bg-tg-border'
                    }`}>
                      <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${
                        settings.turboMode ? 'left-5' : 'left-1'
                      }`} />
                    </span>
                  </button>
                </div>

                {settings.turboMode ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-orange-400 mb-2 flex items-center gap-2">
                        <Zap className="w-4 h-4" /> Задержка (ms)
                      </label>
                      <input
                        type="number" min="0" max="5000" step="10"
                        value={settings.turboDelayMs}
                        onChange={e => setSettings(s => ({ ...s, turboDelayMs: Math.max(0, parseInt(e.target.value) || 0) }))}
                        className="w-full bg-tg-darker border border-orange-500/30 rounded-xl px-4 py-3 text-sm text-orange-400 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/30 transition-all"
                      />
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {[0, 10, 50, 100, 200, 500].map(ms => (
                          <button
                            key={ms}
                            onClick={() => { tma.haptic.selection(); setSettings(s => ({ ...s, turboDelayMs: ms })); }}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                              settings.turboDelayMs === ms
                                ? 'bg-orange-500 text-white'
                                : 'bg-tg-darker text-tg-muted border border-tg-border hover:border-orange-500/50'
                            }`}
                          >
                            {ms}ms
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-orange-400 mb-2 flex items-center gap-2">
                        <Layers className="w-4 h-4" /> Параллельно
                      </label>
                      <input
                        type="number" min="1" max="20"
                        value={settings.parallelUploads}
                        onChange={e => setSettings(s => ({ ...s, parallelUploads: Math.min(20, Math.max(1, parseInt(e.target.value) || 1)) }))}
                        className="w-full bg-tg-darker border border-orange-500/30 rounded-xl px-4 py-3 text-sm text-orange-400 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/30 transition-all"
                      />
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {[1, 3, 5, 10, 15, 20].map(n => (
                          <button
                            key={n}
                            onClick={() => { tma.haptic.selection(); setSettings(s => ({ ...s, parallelUploads: n })); }}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                              settings.parallelUploads === n
                                ? 'bg-orange-500 text-white'
                                : 'bg-tg-darker text-tg-muted border border-tg-border hover:border-orange-500/50'
                            }`}
                          >
                            ×{n}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-orange-500/10 to-red-500/10 border border-orange-500/30 rounded-xl p-3">
                      <p className="text-xs text-orange-400 flex items-center gap-1.5">
                        <Zap className="w-3.5 h-3.5" />
                        <span className="font-semibold">
                          {settings.parallelUploads > 1
                            ? `${settings.parallelUploads} файлов ×, ${settings.turboDelayMs}ms`
                            : `Последовательно, ${settings.turboDelayMs}ms`
                          }
                        </span>
                      </p>
                      <p className="text-[10px] text-orange-400/60 mt-1">⚠️ Telegram может ограничить скорость (429)</p>
                    </div>
                  </>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-tg-muted mb-2 flex items-center gap-2">
                      <Clock className="w-4 h-4" /> Задержка между постами (сек)
                    </label>
                    <input
                      type="number" min="1" max="60"
                      value={settings.delayBetweenPosts}
                      onChange={e => setSettings(s => ({ ...s, delayBetweenPosts: Math.max(1, parseInt(e.target.value) || 3) }))}
                      className="w-full bg-tg-darker border border-tg-border rounded-xl px-4 py-3 text-sm text-tg-text focus:outline-none focus:border-tg-blue focus:ring-1 focus:ring-tg-blue/30 transition-all"
                    />
                  </div>
                )}

                <button
                  onClick={handleTestConnection}
                  disabled={!settings.botToken || testingConnection}
                  className="w-full flex items-center justify-center gap-2 bg-tg-blue/10 hover:bg-tg-blue/20 text-tg-blue border border-tg-blue/30 rounded-xl px-4 py-3 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {testingConnection ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  Проверить подключение
                </button>
                {connectionError && (
                  <p className="text-xs text-tg-error flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> {connectionError}
                  </p>
                )}
                {botInfo && (
                  <p className="text-xs text-tg-success flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> Подключено к @{botInfo.username}
                  </p>
                )}
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
          className={`relative border-2 border-dashed rounded-2xl p-6 sm:p-10 text-center cursor-pointer transition-all ${
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
          <div className="flex flex-col items-center gap-3 sm:gap-4">
            <div className={`w-14 h-14 sm:w-16 sm:h-16 rounded-2xl flex items-center justify-center ${
              dragOverZone ? 'bg-tg-blue/20' : 'bg-tg-darker'
            }`}>
              <Upload className={`w-7 h-7 sm:w-8 sm:h-8 ${dragOverZone ? 'text-tg-blue' : 'text-tg-muted'}`} />
            </div>
            <div>
              <p className="text-base sm:text-lg font-medium text-tg-text mb-1">
                {dragOverZone ? 'Отпустите файлы' : 'Загрузите медиа'}
              </p>
              <p className="text-xs sm:text-sm text-tg-muted">
                Нажмите или перетащите • Фото и видео
              </p>
            </div>
            <div className="flex items-center gap-4 sm:gap-6 text-tg-muted">
              <span className="flex items-center gap-1.5 text-[10px] sm:text-xs">
                <Image className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> JPG, PNG, GIF, WebP
              </span>
              <span className="flex items-center gap-1.5 text-[10px] sm:text-xs">
                <Film className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> MP4, MOV, AVI
              </span>
            </div>
          </div>
        </div>

        {/* Global Caption */}
        {mediaItems.length > 0 && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-4 sm:p-5 animate-slide-up">
            <label className="block text-sm font-medium text-tg-muted mb-2 sm:mb-3">
              📝 Общая подпись
            </label>
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
              <textarea
                value={globalCaption}
                onChange={e => setGlobalCaption(e.target.value)}
                placeholder="Подпись для всех файлов..."
                rows={2}
                className="flex-1 bg-tg-darker border border-tg-border rounded-xl px-4 py-3 text-sm text-tg-text placeholder-tg-muted/50 focus:outline-none focus:border-tg-blue focus:ring-1 focus:ring-tg-blue/30 transition-all resize-none"
              />
              <div className="flex sm:flex-col gap-2">
                <button
                  onClick={applyGlobalCaption}
                  className="flex-1 sm:flex-none px-4 py-2 bg-tg-blue/10 text-tg-blue border border-tg-blue/30 rounded-xl text-xs font-medium hover:bg-tg-blue/20 transition-all"
                >
                  К пустым
                </button>
                <button
                  onClick={applyGlobalCaptionToAll}
                  className="flex-1 sm:flex-none px-4 py-2 bg-tg-warning/10 text-tg-warning border border-tg-warning/30 rounded-xl text-xs font-medium hover:bg-tg-warning/20 transition-all"
                >
                  Ко всем
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Stats Bar */}
        {mediaItems.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 bg-tg-card rounded-2xl border border-tg-border px-4 sm:px-5 py-3 sm:py-4">
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <span className="text-sm text-tg-text font-medium">
                <span className="text-tg-blue">{mediaItems.length}</span> файлов
              </span>
              {photoCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-tg-muted">
                  <Image className="w-3 h-3" /> {photoCount}
                </span>
              )}
              {videoCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-tg-muted">
                  <Film className="w-3 h-3" /> {videoCount}
                </span>
              )}
              {successCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-tg-success">
                  <CheckCircle className="w-3 h-3" /> {successCount}
                </span>
              )}
              {errorCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-tg-error">
                  <AlertCircle className="w-3 h-3" /> {errorCount}
                </span>
              )}
              <span className="text-xs text-tg-muted">
                📦 {formatFileSize(mediaItems.reduce((s, m) => s + m.file.size, 0))}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {publishState === 'done' && (
                <button onClick={resetStatuses} className="flex items-center gap-1 px-3 py-1.5 bg-tg-blue/10 text-tg-blue rounded-lg text-xs hover:bg-tg-blue/20 transition-all">
                  <RotateCcw className="w-3 h-3" /> Сбросить
                </button>
              )}
              <button
                onClick={clearAll}
                disabled={publishState === 'publishing'}
                className="flex items-center gap-1 px-3 py-1.5 bg-tg-error/10 text-tg-error rounded-lg text-xs hover:bg-tg-error/20 transition-all disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" /> Очистить
              </button>
            </div>
          </div>
        )}

        {/* Progress Panel */}
        {(publishState === 'publishing' || publishState === 'paused') && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-tg-text flex items-center gap-2">
                {publishState === 'paused' ? (
                  <>⏸️ Пауза</>
                ) : (
                  <><Loader2 className="w-4 h-4 animate-spin text-tg-blue" /> Публикация...</>
                )}
              </span>
              <span className="text-xs sm:text-sm text-tg-muted">
                {successCount + errorCount} / {mediaItems.length}
              </span>
            </div>

            <div className="space-y-3">
              <div className="h-3 bg-tg-darker rounded-full overflow-hidden relative">
                <div
                  className="h-full bg-gradient-to-r from-tg-blue to-blue-400 rounded-full transition-all duration-300"
                  style={{ width: `${uploadStats.overallPercent}%` }}
                />
                {publishState === 'publishing' && uploadingCount > 0 && (
                  <div className="absolute inset-0 overflow-hidden rounded-full">
                    <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                <div className="bg-tg-darker rounded-xl px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-tg-muted mb-1">
                    <ArrowUpFromLine className="w-3 h-3" />
                    <span className="text-[10px] uppercase tracking-wider font-medium">Загружено</span>
                  </div>
                  <p className="text-xs sm:text-sm font-bold text-tg-text">
                    {formatFileSize(uploadStats.currentLoaded)}
                    <span className="text-tg-muted font-normal text-[10px] sm:text-xs"> / {formatFileSize(uploadStats.totalBytes)}</span>
                  </p>
                </div>
                <div className="bg-tg-darker rounded-xl px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-tg-muted mb-1">
                    <Gauge className="w-3 h-3" />
                    <span className="text-[10px] uppercase tracking-wider font-medium">Скорость</span>
                  </div>
                  <p className="text-xs sm:text-sm font-bold text-tg-blue">
                    {uploadStats.totalSpeed > 0 ? formatSpeed(uploadStats.totalSpeed) : '—'}
                  </p>
                </div>
                <div className="bg-tg-darker rounded-xl px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-tg-muted mb-1">
                    <Clock className="w-3 h-3" />
                    <span className="text-[10px] uppercase tracking-wider font-medium">Осталось</span>
                  </div>
                  <p className="text-xs sm:text-sm font-bold text-tg-warning">
                    {uploadStats.totalSpeed > 0 ? formatETA(uploadStats.eta) : '—'}
                  </p>
                </div>
                <div className="bg-tg-darker rounded-xl px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-tg-muted mb-1">
                    <CheckCircle className="w-3 h-3" />
                    <span className="text-[10px] uppercase tracking-wider font-medium">Прогресс</span>
                  </div>
                  <p className="text-xs sm:text-sm font-bold text-tg-success">
                    {uploadStats.overallPercent.toFixed(1)}%
                  </p>
                </div>
              </div>

              {uploadingCount > 0 && (
                <div className="space-y-1.5 pt-1">
                  {mediaItems.filter(m => m.status === 'uploading').map((item) => (
                    <div key={item.id} className="bg-tg-darker/50 rounded-lg px-3 py-2 flex items-center gap-3">
                      <Loader2 className="w-3.5 h-3.5 text-tg-blue animate-spin shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] text-tg-text truncate mr-2">{item.file.name}</span>
                          <span className="text-[10px] text-tg-muted whitespace-nowrap">
                            {item.uploadProgress ? `${item.uploadProgress.percent}%` : '0%'}
                          </span>
                        </div>
                        <div className="h-1 bg-tg-border rounded-full overflow-hidden">
                          <div
                            className="h-full bg-tg-blue rounded-full transition-all duration-200"
                            style={{ width: `${item.uploadProgress?.percent || 0}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[10px] text-tg-muted">
                            {formatFileSize(item.uploadProgress?.loaded || 0)} / {formatFileSize(item.file.size)}
                          </span>
                          <span className="text-[10px] text-tg-blue">
                            {item.uploadProgress && item.uploadProgress.speed > 0
                              ? formatSpeed(item.uploadProgress.speed) : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {publishStartTime > 0 && (
                <div className="text-center">
                  <ElapsedTimer startTime={publishStartTime} running={publishState === 'publishing'} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Media Grid */}
        {mediaItems.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
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
                <div className="relative aspect-video bg-tg-darker overflow-hidden">
                  {item.type === 'photo' ? (
                    <img src={item.previewUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <video
                      src={item.previewUrl}
                      className="w-full h-full object-cover"
                      muted
                      preload="metadata"
                      onLoadedMetadata={e => { (e.target as HTMLVideoElement).currentTime = 1; }}
                    />
                  )}

                  <div className="absolute top-2 left-2 flex items-center gap-1.5">
                    <span className={`px-2 py-0.5 rounded-lg text-[10px] sm:text-xs font-medium backdrop-blur-sm ${
                      item.type === 'photo' ? 'bg-tg-blue/80 text-white' : 'bg-purple-600/80 text-white'
                    }`}>
                      {item.type === 'photo' ? '📷 Фото' : '🎬 Видео'}
                    </span>
                    <span className="px-1.5 py-0.5 rounded-lg text-[10px] bg-black/50 text-white backdrop-blur-sm">
                      #{index + 1}
                    </span>
                  </div>

                  {/* Upload overlay */}
                  {item.status === 'uploading' && (
                    <div className="absolute inset-0 bg-black/70 flex items-center justify-center backdrop-blur-sm">
                      <div className="flex flex-col items-center gap-2 w-full px-5">
                        <Loader2 className="w-6 h-6 text-tg-blue animate-spin" />
                        <span className="text-sm text-white font-semibold">Отправка</span>
                        <div className="w-full space-y-1.5">
                          <div className="h-2 bg-white/10 rounded-full overflow-hidden w-full">
                            <div
                              className="h-full bg-gradient-to-r from-tg-blue to-cyan-400 rounded-full transition-all duration-200"
                              style={{ width: `${item.uploadProgress?.percent || 0}%` }}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-white/80 font-medium">
                              {formatFileSize(item.uploadProgress?.loaded || 0)}
                              <span className="text-white/50"> / {formatFileSize(item.file.size)}</span>
                            </span>
                            <span className="text-[10px] text-cyan-300 font-bold">
                              {item.uploadProgress?.percent || 0}%
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] text-white/60 flex items-center gap-1">
                              <Gauge className="w-2.5 h-2.5" />
                              {item.uploadProgress && item.uploadProgress.speed > 0
                                ? formatSpeed(item.uploadProgress.speed) : '...'}
                            </span>
                            <span className="text-[9px] text-white/60 flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" />
                              {item.uploadProgress && item.uploadProgress.speed > 0
                                ? formatETA((item.file.size - (item.uploadProgress.loaded || 0)) / item.uploadProgress.speed)
                                : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {item.status === 'success' && (
                    <div className="absolute inset-0 bg-tg-success/20 flex items-center justify-center">
                      <div className="flex flex-col items-center gap-1">
                        <CheckCircle className="w-8 h-8 sm:w-10 sm:h-10 text-tg-success" />
                        <span className="text-xs text-tg-success font-medium">Отправлено</span>
                      </div>
                    </div>
                  )}

                  {item.status === 'error' && (
                    <div className="absolute inset-0 bg-tg-error/20 flex items-center justify-center backdrop-blur-sm">
                      <div className="flex flex-col items-center gap-2 px-4 text-center">
                        <AlertCircle className="w-7 h-7 text-tg-error" />
                        <span className="text-[10px] sm:text-xs text-tg-error">{item.errorMessage}</span>
                      </div>
                    </div>
                  )}

                  {publishState === 'idle' && (
                    <div className="absolute top-2 right-2 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); removeItem(item.id); }}
                        className="w-7 h-7 sm:w-8 sm:h-8 bg-tg-error/80 hover:bg-tg-error text-white rounded-lg flex items-center justify-center backdrop-blur-sm transition-colors"
                      >
                        <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      </button>
                    </div>
                  )}

                  {publishState === 'idle' && (
                    <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing hidden sm:block">
                      <div className="w-8 h-8 bg-black/50 backdrop-blur-sm rounded-lg flex items-center justify-center text-white/70 hover:text-white">
                        <GripVertical className="w-4 h-4" />
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] sm:text-xs text-tg-muted truncate flex-1 mr-2" title={item.file.name}>
                      {item.file.name}
                    </p>
                    <span className="text-[10px] sm:text-xs text-tg-muted whitespace-nowrap">
                      {formatFileSize(item.file.size)}
                    </span>
                  </div>
                  <textarea
                    value={item.caption}
                    onChange={e => updateCaption(item.id, e.target.value)}
                    placeholder="Подпись..."
                    rows={2}
                    disabled={publishState !== 'idle'}
                    className="w-full bg-tg-darker border border-tg-border rounded-xl px-3 py-2 text-sm text-tg-text placeholder-tg-muted/50 focus:outline-none focus:border-tg-blue focus:ring-1 focus:ring-tg-blue/30 transition-all resize-none disabled:opacity-50"
                  />
                </div>
              </div>
            ))}

            {publishState === 'idle' && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-tg-border rounded-2xl flex flex-col items-center justify-center gap-3 min-h-[200px] sm:min-h-[250px] hover:border-tg-muted hover:bg-tg-card/50 transition-all group"
              >
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-tg-card border border-tg-border flex items-center justify-center group-hover:border-tg-muted transition-colors">
                  <Plus className="w-5 h-5 sm:w-6 sm:h-6 text-tg-muted group-hover:text-tg-text transition-colors" />
                </div>
                <span className="text-xs sm:text-sm text-tg-muted group-hover:text-tg-text transition-colors">Добавить ещё</span>
              </button>
            )}
          </div>
        )}

        {/* Empty State (no TMA welcome) */}
        {mediaItems.length === 0 && !(tma.isTMA && !isConfigured) && (
          <div className="text-center py-12 sm:py-16">
            <div className="w-16 h-16 sm:w-20 sm:h-20 bg-tg-card rounded-3xl flex items-center justify-center mx-auto mb-4 sm:mb-6 border border-tg-border">
              <FileWarning className="w-8 h-8 sm:w-10 sm:h-10 text-tg-muted" />
            </div>
            <h3 className="text-lg sm:text-xl font-semibold text-tg-text mb-2">Нет файлов</h3>
            <p className="text-sm text-tg-muted max-w-md mx-auto px-4">
              Загрузите фото или видео, добавьте подписи и опубликуйте в Telegram канал
            </p>
          </div>
        )}

        {/* Instructions for non-TMA */}
        {mediaItems.length === 0 && !tma.isTMA && (
          <div className="bg-tg-card rounded-2xl border border-tg-border p-4 sm:p-6 mt-4 sm:mt-8">
            <h3 className="text-sm sm:text-base font-semibold text-tg-text mb-3 sm:mb-4">📖 Как пользоваться</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {[
                { step: '1', title: 'Создайте бота', desc: '@BotFather → создать бота → скопировать токен' },
                { step: '2', title: 'Добавьте в канал', desc: 'Бот = администратор канала с правом на посты' },
                { step: '3', title: 'Загрузите медиа', desc: 'Фото / видео + подписи к каждому файлу' },
                { step: '4', title: 'Публикуйте', desc: 'Всё отправится по очереди автоматически' },
              ].map(item => (
                <div key={item.step} className="flex gap-3">
                  <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-tg-blue/10 text-tg-blue flex items-center justify-center text-xs sm:text-sm font-bold shrink-0">
                    {item.step}
                  </div>
                  <div>
                    <h4 className="text-xs sm:text-sm font-medium text-tg-text">{item.title}</h4>
                    <p className="text-[10px] sm:text-xs text-tg-muted mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* TMA setup hint for browser users */}
            <div className="mt-4 bg-tg-blue/5 border border-tg-blue/20 rounded-xl p-4">
              <h4 className="text-sm font-medium text-tg-blue mb-2 flex items-center gap-2">
                💡 Совет: используйте как Telegram Mini App
              </h4>
              <div className="text-xs text-tg-muted space-y-1">
                <p>Это приложение можно открывать прямо внутри Telegram!</p>
                <p>1. Создайте бота через @BotFather</p>
                <p>2. Отправьте <code className="px-1.5 py-0.5 bg-tg-darker rounded text-tg-text">/newapp</code> → выберите бота → укажите URL этого сайта</p>
                <p>3. Отправьте <code className="px-1.5 py-0.5 bg-tg-darker rounded text-tg-text">/setmenubutton</code> → выберите бота → укажите URL</p>
                <p>4. Теперь при входе в бота будет кнопка, открывающая это приложение!</p>
              </div>
            </div>
          </div>
        )}

        {/* Publish Bar */}
        {mediaItems.length > 0 && (
          <div className="fixed bottom-0 left-0 right-0 z-40 p-3 sm:p-4">
            <div className="max-w-6xl mx-auto bg-tg-dark/95 backdrop-blur-md rounded-2xl border border-tg-border p-3 sm:p-4 shadow-2xl shadow-black/50">
              <div className="flex flex-col gap-2 sm:gap-3">
                {/* Mini progress */}
                {(publishState === 'publishing' || publishState === 'paused') && (
                  <div className="flex items-center gap-3 text-xs">
                    <div className="flex-1 h-1.5 bg-tg-darker rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-tg-blue to-cyan-400 rounded-full transition-all duration-300"
                        style={{ width: `${uploadStats.overallPercent}%` }}
                      />
                    </div>
                    <div className="flex items-center gap-2 sm:gap-3 text-tg-muted shrink-0">
                      <span className="text-tg-text font-medium">{uploadStats.overallPercent.toFixed(0)}%</span>
                      <span className="hidden sm:inline">↑ {formatSpeed(uploadStats.totalSpeed)}</span>
                      <span>{formatFileSize(uploadStats.currentLoaded)}</span>
                      {uploadStats.totalSpeed > 0 && <span>⏱ {formatETA(uploadStats.eta)}</span>}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs sm:text-sm text-tg-muted min-w-0 flex-1">
                    {publishState === 'done' ? (
                      <span className="text-tg-success flex items-center gap-1.5">
                        <CheckCircle className="w-4 h-4 shrink-0" />
                        <span className="truncate">
                          ✅ {successCount}/{mediaItems.length}
                          {errorCount > 0 && <span className="text-tg-error"> ({errorCount} ошибок)</span>}
                        </span>
                      </span>
                    ) : publishState === 'publishing' ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-tg-blue flex items-center gap-1.5">
                          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                          <span className="truncate">{successCount + errorCount + uploadingCount}/{mediaItems.length}</span>
                        </span>
                        {uploadStats.currentLoaded > 0 && (
                          <span className="text-[10px] text-tg-muted pl-6">
                            {formatFileSize(uploadStats.currentLoaded)} • {formatSpeed(uploadStats.totalSpeed)}
                          </span>
                        )}
                      </div>
                    ) : publishState === 'paused' ? (
                      <span className="text-tg-warning flex items-center gap-1.5">
                        <Pause className="w-4 h-4 shrink-0" /> Пауза
                      </span>
                    ) : (
                      <span className="truncate block">
                        {!isConfigured ? '⚠️ Настройте бота' : `${pendingCount} файлов • ${formatFileSize(mediaItems.reduce((s, m) => s + m.file.size, 0))}`}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {publishState === 'idle' && (
                      <button
                        onClick={startPublishing}
                        disabled={!isConfigured || pendingCount === 0}
                        className={`flex items-center gap-1.5 px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl font-medium text-xs sm:text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg ${
                          settings.turboMode
                            ? 'bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white shadow-orange-500/20'
                            : 'bg-tg-blue hover:bg-tg-blue/90 text-white shadow-tg-blue/20'
                        }`}
                      >
                        {settings.turboMode ? <Zap className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                        <span className="hidden sm:inline">{settings.turboMode ? '⚡ TURBO' : 'Опубликовать'}</span>
                        <span className="sm:hidden">{settings.turboMode ? '⚡' : 'Старт'}</span>
                      </button>
                    )}
                    {publishState === 'publishing' && (
                      <>
                        <button
                          onClick={pausePublishing}
                          className="flex items-center gap-1.5 px-3 sm:px-4 py-2.5 sm:py-3 bg-tg-warning/20 text-tg-warning rounded-xl font-medium text-xs sm:text-sm hover:bg-tg-warning/30 transition-all"
                        >
                          <Pause className="w-4 h-4" />
                          <span className="hidden sm:inline">Пауза</span>
                        </button>
                        <button
                          onClick={cancelPublishing}
                          className="flex items-center gap-1.5 px-3 sm:px-4 py-2.5 sm:py-3 bg-tg-error/20 text-tg-error rounded-xl font-medium text-xs sm:text-sm hover:bg-tg-error/30 transition-all"
                        >
                          <X className="w-4 h-4" />
                          <span className="hidden sm:inline">Стоп</span>
                        </button>
                      </>
                    )}
                    {publishState === 'paused' && (
                      <>
                        <button
                          onClick={resumePublishing}
                          className="flex items-center gap-1.5 px-3 sm:px-4 py-2.5 sm:py-3 bg-tg-blue hover:bg-tg-blue/90 text-white rounded-xl font-medium text-xs sm:text-sm transition-all"
                        >
                          <Play className="w-4 h-4" />
                          <span className="hidden sm:inline">Продолжить</span>
                        </button>
                        <button
                          onClick={cancelPublishing}
                          className="flex items-center gap-1.5 px-3 sm:px-4 py-2.5 sm:py-3 bg-tg-error/20 text-tg-error rounded-xl font-medium text-xs sm:text-sm hover:bg-tg-error/30 transition-all"
                        >
                          <X className="w-4 h-4" />
                          <span className="hidden sm:inline">Стоп</span>
                        </button>
                      </>
                    )}
                    {publishState === 'done' && (
                      <button
                        onClick={resetStatuses}
                        className="flex items-center gap-1.5 px-4 sm:px-6 py-2.5 sm:py-3 bg-tg-blue hover:bg-tg-blue/90 text-white rounded-xl font-medium text-xs sm:text-sm transition-all"
                      >
                        <RotateCcw className="w-4 h-4" />
                        <span className="hidden sm:inline">Заново</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// Elapsed timer component
function ElapsedTimer({ startTime, running }: { startTime: number; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime, running]);

  useEffect(() => {
    if (!running) {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }
  }, [running, startTime]);

  return (
    <span className="text-[11px] text-tg-muted">
      ⏱ Прошло: {formatETA(elapsed)}
    </span>
  );
}
