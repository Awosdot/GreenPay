import { useEffect } from 'react';
<<<<<<< HEAD
<<<<<<< HEAD
import { useFonts, Lora_700Bold } from '@expo-google-fonts/lora';
import { useColorScheme } from 'react-native';
import { ThemeProvider, themes } from './theme';
import { useDeepLink } from '../hooks/useDeepLink';
import { useRecurringReminders } from '../hooks/useRecurringReminders';
import { AppInitProvider, useAppInit } from '../src/context/AppInitContext';
import { assertStellarNetworkConfigConsistency } from '../utils/stellarNetwork';
import { initCrashReporter } from '../utils/crashReporter';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
=======
import { useRouter } from 'expo-router';
=======
import { Stack, useRouter } from 'expo-router';
<<<<<<< HEAD
import { ThemeProvider } from '../context/ThemeContext'; // Adjust path if necessary
import { AppInitProvider } from '../context/AppInitContext'; // Adjust path if necessary
>>>>>>> 04342f4 (fix(mobile): complete device token lifecycle and drop broken imports)
import { registerDeviceToken, setupNotificationListener } from '../utils/notifications';
>>>>>>> 39eada5 (fix(mobile): register device token lifecycle and encode query tokens (#363))

function AppShell() {
<<<<<<< HEAD
  const colorScheme = useColorScheme();
  const themeMode = colorScheme === 'dark' ? 'dark' : 'light';
  const theme = themes[themeMode];
  const { publicKey } = useWallet();
  const { isCompromised } = useDeviceIntegrity();

  const { isHydrated } = useAppInit();
  const [fontsLoaded, fontError] = useFonts({
    Lora_700Bold,
  });

  // Initialise crash reporting before any navigation or wallet hooks execute.
  // Wrapped in try/catch so a bad config can never propagate as a boot crash
  // (Requirement 5.6). dryRun is true in dev and preview builds (Req 5.7).
  useEffect(() => {
    try {
      initCrashReporter({
        dsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? '',
        updateId: Updates.updateId ?? null,
        runtimeVersion: Updates.runtimeVersion ?? null,
        dryRun:
          __DEV__ ||
          Constants.expoConfig?.extra?.buildProfile === 'preview',
      });
    } catch (err) {
      console.error('[AppShell] initCrashReporter failed:', err);
    }
  }, []);

  useEffect(() => {
    // Fail fast if Horizon URL and STELLAR_NETWORK disagree (issue #145).
    assertStellarNetworkConfigConsistency();
  }, []);

  useEffect(() => {
    if ((fontsLoaded || fontError) && isHydrated) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError, isHydrated]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

=======
>>>>>>> 39eada5 (fix(mobile): register device token lifecycle and encode query tokens (#363))
=======
import { ThemeProvider } from './theme';
import { AppInitProvider, useAppInit } from '../src/context/AppInitContext';
import { registerDeviceToken, requestPushToken, setupNotificationListener } from '../utils/notifications';

function AppShell() {
  const router = useRouter();
  const { walletPublicKey } = useAppInit();

  useEffect(() => {
    // 1. Request permissions/token and register the device on mount
    (async () => {
      const token = await requestPushToken();
      if (token) {
        await registerDeviceToken(token, walletPublicKey ?? undefined);
      }
    })();

    // 2. Mount response listener and tear down on unmount
    const removeListener = setupNotificationListener((deepLinkUrl) => {
      if (deepLinkUrl) {
        router.push(deepLinkUrl);
      }
    });

    return () => {
      if (removeListener) removeListener();
    };
  }, [walletPublicKey]);

>>>>>>> dc1a3a1 (fix(mobile): correct import paths and align push token registration with tests)
  return (
    <ThemeProvider>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="profile/[address]" options={{ title: 'Donor Profile' }} />
        <Stack.Screen name="leaderboard" options={{ title: 'Leaderboard' }} />
        <Stack.Screen name="recurring" options={{ title: 'Monthly Giving' }} />
        <Stack.Screen name="sync-conflicts" options={{ title: 'Sync Donations' }} />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <AppInitProvider>
      <AppShell />
    </AppInitProvider>
  );
}