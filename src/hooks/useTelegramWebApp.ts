import { useEffect, useState, useCallback, useRef } from 'react';

export interface TMAState {
  isAvailable: boolean;
  isTMA: boolean;
  webApp: TelegramWebApp | null;
  user: TelegramWebAppUser | null;
  colorScheme: 'light' | 'dark';
  platform: string;
  viewportHeight: number;
  startParam: string | null;
  haptic: {
    impact: (style?: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notification: (type?: 'error' | 'success' | 'warning') => void;
    selection: () => void;
  };
  showConfirm: (message: string) => Promise<boolean>;
  showAlert: (message: string) => Promise<void>;
  close: () => void;
}

/**
 * Checks if we're TRULY inside a Telegram WebApp context.
 * telegram-web-app.js sets window.Telegram.WebApp even outside TG,
 * but initData will be empty if not inside Telegram.
 */
function isInsideTelegram(): boolean {
  try {
    const tg = window.Telegram?.WebApp;
    if (!tg) return false;
    // If initData is a non-empty string, we're inside TG
    if (tg.initData && tg.initData.length > 0) return true;
    // Also check if platform is set to something meaningful
    if (tg.platform && tg.platform !== 'unknown') return true;
    // Check URL hash for tgWebAppData
    if (window.location.hash.includes('tgWebAppData')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Dynamically loads the Telegram WebApp SDK script
 */
function loadTelegramSDK(): Promise<boolean> {
  return new Promise((resolve) => {
    // Already loaded?
    if (window.Telegram?.WebApp) {
      resolve(true);
      return;
    }

    // Check if script tag already exists
    const existingScript = document.querySelector('script[src*="telegram.org/js/telegram-web-app"]');
    if (existingScript) {
      // Wait for it
      existingScript.addEventListener('load', () => resolve(true));
      existingScript.addEventListener('error', () => resolve(false));
      // Maybe it already loaded
      if (window.Telegram?.WebApp) {
        resolve(true);
      }
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);

    // Timeout after 5 seconds — don't block the app
    setTimeout(() => resolve(false), 5000);
  });
}

export function useTelegramWebApp(): TMAState {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isTMA, setIsTMA] = useState(false);
  const [user, setUser] = useState<TelegramWebAppUser | null>(null);
  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>('dark');
  const [platform, setPlatform] = useState('unknown');
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  const [startParam, setStartParam] = useState<string | null>(null);
  const webAppRef = useRef<TelegramWebApp | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Try to load the SDK
      const loaded = await loadTelegramSDK();

      if (cancelled) return;

      const tg = window.Telegram?.WebApp;

      if (!loaded || !tg) {
        setIsAvailable(false);
        setIsTMA(false);
        return;
      }

      webAppRef.current = tg;
      setIsAvailable(true);

      // Check if we're ACTUALLY inside Telegram
      const insideTG = isInsideTelegram();
      setIsTMA(insideTG);

      if (insideTG) {
        try { tg.ready(); } catch { /* */ }
        try { tg.expand(); } catch { /* */ }
        try { tg.disableVerticalSwipes(); } catch { /* */ }

        setColorScheme(tg.colorScheme || 'dark');
        setPlatform(tg.platform || 'unknown');
        setViewportHeight(tg.viewportStableHeight || window.innerHeight);

        if (tg.initDataUnsafe?.user) {
          setUser(tg.initDataUnsafe.user);
        }
        if (tg.initDataUnsafe?.start_param) {
          setStartParam(tg.initDataUnsafe.start_param);
        }

        document.body.classList.add('tma-active');

        try {
          tg.setHeaderColor(tg.themeParams.header_bg_color || tg.themeParams.bg_color || '#14171B');
          tg.setBackgroundColor(tg.themeParams.bg_color || '#14171B');
        } catch { /* */ }

        try {
          tg.setBottomBarColor(tg.themeParams.bottom_bar_bg_color || tg.themeParams.secondary_bg_color || '#1B1F24');
        } catch { /* */ }

        const handleViewport = () => {
          try {
            if (tg) setViewportHeight(tg.viewportStableHeight || window.innerHeight);
          } catch { /* */ }
        };
        const handleTheme = () => {
          try {
            if (tg) setColorScheme(tg.colorScheme || 'dark');
          } catch { /* */ }
        };

        try {
          tg.onEvent('viewportChanged', handleViewport);
          tg.onEvent('themeChanged', handleTheme);
        } catch { /* */ }

        return () => {
          try { tg.offEvent('viewportChanged', handleViewport); } catch { /* */ }
          try { tg.offEvent('themeChanged', handleTheme); } catch { /* */ }
          document.body.classList.remove('tma-active');
        };
      }
    }

    init();

    return () => {
      cancelled = true;
      document.body.classList.remove('tma-active');
    };
  }, []);

  const hapticImpact = useCallback((style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' = 'medium') => {
    try { if (isTMA) webAppRef.current?.HapticFeedback.impactOccurred(style); } catch { /* */ }
  }, [isTMA]);

  const hapticNotification = useCallback((type: 'error' | 'success' | 'warning' = 'success') => {
    try { if (isTMA) webAppRef.current?.HapticFeedback.notificationOccurred(type); } catch { /* */ }
  }, [isTMA]);

  const hapticSelection = useCallback(() => {
    try { if (isTMA) webAppRef.current?.HapticFeedback.selectionChanged(); } catch { /* */ }
  }, [isTMA]);

  const showConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      try {
        if (isTMA && webAppRef.current) {
          webAppRef.current.showConfirm(message, (confirmed) => resolve(confirmed));
        } else {
          resolve(window.confirm(message));
        }
      } catch {
        resolve(window.confirm(message));
      }
    });
  }, [isTMA]);

  const showAlert = useCallback((message: string): Promise<void> => {
    return new Promise((resolve) => {
      try {
        if (isTMA && webAppRef.current) {
          webAppRef.current.showAlert(message, () => resolve());
        } else {
          window.alert(message);
          resolve();
        }
      } catch {
        window.alert(message);
        resolve();
      }
    });
  }, [isTMA]);

  const closeApp = useCallback(() => {
    try { if (isTMA) webAppRef.current?.close(); } catch { /* */ }
  }, [isTMA]);

  return {
    isAvailable,
    isTMA,
    webApp: webAppRef.current,
    user,
    colorScheme,
    platform,
    viewportHeight,
    startParam,
    haptic: {
      impact: hapticImpact,
      notification: hapticNotification,
      selection: hapticSelection,
    },
    showConfirm,
    showAlert,
    close: closeApp,
  };
}
