import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Camera } from 'expo-camera';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Util: guarda/lee en AsyncStorage */
const saveKV = (k, v) => AsyncStorage.setItem(k, JSON.stringify(v));
const readKV = async (k, def = null) => {
  try {
    const raw = await AsyncStorage.getItem(k);
    return raw ? JSON.parse(raw) : def;
  } catch {
    return def;
  }
};

export default function App() {
  // Tiempo
  const [hour, setHour] = useState(5);
  const [minute, setMinute] = useState(0);
  const [isPM, setIsPM] = useState(false); // AM(false)/PM(true)

  // Ajustes
  const [durationMin, setDurationMin] = useState(5);
  const [preAlarmNotify, setPreAlarmNotify] = useState(true);

  // Estado de ejecución
  const [running, setRunning] = useState(false);

  // Cámara/linterna
  const [camPermission, requestCam] = Camera.useCameraPermissions();
  const camRef = useRef(null);

  // Audio
  const soundRef = useRef(new Audio.Sound());
  const [toneUri, setToneUri] = useState(null);

  // Timer de amanecer
  const sunriseTimer = useRef(null);
  const stopTimer = useRef(null);

  /** Cargar ajustes persistidos */
  useEffect(() => {
    (async () => {
      // permisos cámara la primera vez
      if (!camPermission?.granted) {
        await requestCam();
      }
      const saved =
        (await readKV('settings', null)) ??
        { hour: 5, minute: 0, isPM: false, durationMin: 5, preAlarmNotify: true };
      setHour(saved.hour);
      setMinute(saved.minute);
      setIsPM(saved.isPM);
      setDurationMin(saved.durationMin);
      setPreAlarmNotify(saved.preAlarmNotify);

      const savedTone = await readKV('toneUri', null);
      if (savedTone) setToneUri(savedTone);
    })();
  }, []);

  /** Limpieza al desmontar */
  useEffect(() => {
    return () => {
      clearTimers();
      try { soundRef.current.unloadAsync(); } catch {}
    };
  }, []);

  function clearTimers() {
    if (sunriseTimer.current) { clearInterval(sunriseTimer.current); sunriseTimer.current = null; }
    if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }
  }

  /** Guardar ajustes */
  async function saveSettings() {
    await saveKV('settings', { hour, minute, isPM, durationMin, preAlarmNotify });
    Alert.alert('Listo', 'Ajustes guardados.');
  }

  /** Seleccionar tono */
  async function pickTone() {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['audio/*', 'public.audio', 'public.mpeg-4'],
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const file = res.assets?.[0];
      if (!file?.uri) return;

      const ext = (file.name?.split('.').pop() || 'm4a').toLowerCase();
      const dest = FileSystem.documentDirectory + `tone-${Date.now()}.${ext}`;
      await FileSystem.copyAsync({ from: file.uri, to: dest });

      await saveKV('toneUri', dest);
      setToneUri(dest);

      // recargar si ya estaba cargado
      try {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      } catch {}
      Alert.alert('Tono actualizado', file.name || 'Audio seleccionado');
    } catch (e) {
      console.warn(e);
      Alert.alert('Error', 'No se pudo seleccionar el audio.');
    }
  }

  /** Calcular Date del próximo disparo */
  function nextAlarmDate() {
    let h24 = isPM ? ((hour % 12) + 12) : (hour % 12);
    const now = new Date();
    const at = new Date();
    at.setHours(h24, minute, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1); // mañana
    return at;
  }

  /** Encender linterna + sonido con fade-in */
  async function startSunrise() {
    if (!camPermission?.granted) {
      const { granted } = await requestCam();
      if (!granted) {
        Alert.alert('Permiso requerido', 'Activa permiso de cámara para encender la linterna.');
        return;
      }
    }

    if (!toneUri) {
      Alert.alert('Selecciona un tono', 'Ve a “Cambiar tono” y elige un audio.');
      return;
    }

    setRunning(true);

    // Preparar audio
    try {
      await soundRef.current.unloadAsync().catch(()=>{});
      await soundRef.current.loadAsync({ uri: toneUri }, { volume: 0.01, shouldPlay: true, isLooping: true });
    } catch (e) {
      console.warn(e);
      Alert.alert('Error de audio', 'No se pudo reproducir el tono.');
    }

    // Simular amanecer con incremento de volumen y linterna encendida
    const totalMs = Math.max(1, durationMin) * 60_000;
    const steps = 60; // 60 pasos
    const stepMs = totalMs / steps;
    let i = 0;

    sunriseTimer.current = setInterval(async () => {
      i += 1;
      const level = Math.min(1, i / steps);
      // volumen
      try { await soundRef.current.setVolumeAsync(level); } catch {}
      // linterna: mantener encendida mientras corre
      // (en Camera, cambiamos flashMode en el render condicional a torch)
      if (i >= steps) {
        clearInterval(sunriseTimer.current);
        sunriseTimer.current = null;
      }
    }, stepMs);

    // Autodetener al terminar la duración + 30s extra
    stopTimer.current = setTimeout(stopAll, totalMs + 30_000);
  }

  /** Programar (simple, con temporizador en primer plano) */
  function scheduleAlarm() {
    const at = nextAlarmDate();
    const diff = at.getTime() - Date.now();
    const mins = Math.round(diff / 60000);
    Alert.alert(
      'Alarma programada',
      `Sonará a las ${formatHourLabel()} (en ~${mins} min). Deja la app abierta/visible en iOS.`
    );
    // Temporizador simple: para funcionamiento real en segundo plano se requiere nativo.
    setTimeout(() => { startSunrise(); }, diff);
  }

  /** Detener todo */
  async function stopAll() {
    clearTimers();
    setRunning(false);
    try {
      await soundRef.current.stopAsync();
      await soundRef.current.unloadAsync();
    } catch {}
  }

  function format2(n) { return n.toString().padStart(2, '0'); }
  function formatHourLabel() {
    const h = hour % 12 === 0 ? 12 : (hour % 12);
    return `${format2(h)}:${format2(minute)} ${isPM ? 'PM' : 'AM'}`;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Despertador Solar (Expo)</Text>

      {/* Hora */}
      <Text style={styles.label}>Hora</Text>
      <View style={styles.row}>
        <TouchableOpacity onPress={() => setHour(h => (h + 23) % 24)} style={styles.roundBtn}><Text>-</Text></TouchableOpacity>
        <Text style={styles.time}>{format2(hour % 12 === 0 ? 12 : (hour % 12))}</Text>
        <TouchableOpacity onPress={() => setHour(h => (h + 1) % 24)} style={styles.roundBtn}><Text>+</Text></TouchableOpacity>

        <Text style={styles.time}>:</Text>

        <TouchableOpacity onPress={() => setMinute(m => (m + 59) % 60)} style={styles.roundBtn}><Text>-</Text></TouchableOpacity>
        <Text style={styles.time}>{format2(minute)}</Text>
        <TouchableOpacity onPress={() => setMinute(m => (m + 1) % 60)} style={styles.roundBtn}><Text>+</Text></TouchableOpacity>

        <View style={{ width: 14 }} />
        <TouchableOpacity onPress={() => setIsPM(v => !v)} style={styles.amPmBtn}>
          <Text style={styles.amPmText}>{isPM ? 'PM' : 'AM'}</Text>
        </TouchableOpacity>
      </View>

      {/* Duración */}
      <Text style={styles.label}>Duración amanecer (min): {durationMin}</Text>
      <View style={styles.row}>
        <TouchableOpacity onPress={() => setDurationMin(d => Math.max(1, d - 1))} style={styles.smallBtn}><Text>-</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => setDurationMin(d => Math.min(60, d + 1))} style={styles.smallBtn}><Text>+</Text></TouchableOpacity>
      </View>

      {/* Pre-recordatorio */}
      <View style={[styles.row, { marginTop: 12 }]}>
        <Text style={styles.label}>Recordatorio 1 min antes</Text>
        <Switch value={preAlarmNotify} onValueChange={setPreAlarmNotify} />
      </View>

      {/* Botones principales */}
      <View style={{ height: 10 }} />

      <Button title="Cambiar tono" onPress={pickTone} />
      <View style={{ height: 8 }} />
      <Button title="Guardar" onPress={saveSettings} />
      <View style={{ height: 8 }} />
      <Button title="Programar" onPress={scheduleAlarm} />
      <View style={{ height: 8 }} />
      <Button title={running ? 'Amaneciendo...' : 'Probar ahora'} onPress={startSunrise} disabled={running} />
      <View style={{ height: 8 }} />
      <Button title="Detener" color={Platform.OS === 'ios' ? '#ff3b30' : '#d32f2f'} onPress={stopAll} />

      {/* Cámara “invisible” para controlar la linterna */}
      {/* iOS requiere que la app esté en primer plano para usar la linterna */}
      <View style={{ width: 1, height: 1, overflow: 'hidden' }}>
        <Camera
          ref={camRef}
          style={{ width: 1, height: 1 }}
          ratio="16:9"
          flashMode={running ? Camera.Constants.FlashMode.torch : Camera.Constants.FlashMode.off}
        />
      </View>

      <Text style={styles.note}>
        iOS limita acciones con la pantalla bloqueada. Deja la app visible para usar la linterna automáticamente.
        Para pantalla apagada, combínalo con tu Atajo de iOS o pasemos a app nativa más adelante.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111', padding: 20, paddingTop: 50 },
  title: { color: '#fff', fontSize: 26, fontWeight: '700', marginBottom: 20 },
  label: { color: '#ddd', fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  time: { color: '#fff', fontSize: 24, width: 40, textAlign: 'center' },
  roundBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: '#333',
    alignItems: 'center', justifyContent: 'center'
  },
  smallBtn: {
    width: 44, height: 36, borderRadius: 6, backgroundColor: '#333',
    alignItems: 'center', justifyContent: 'center', marginHorizontal: 4
  },
  amPmBtn: {
    paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#444', borderRadius: 6
  },
  amPmText: { color: '#fff', fontWeight: '600' },
  note: { color: '#aaa', fontSize: 13, marginTop: 14, lineHeight: 18 },
});
