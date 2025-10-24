import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Button,
  Switch,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { Slider } from '@miblanchard/react-native-slider';
import * as DocumentPicker from 'expo-document-picker';
import * as Notifications from 'expo-notifications';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Audio } from 'expo-av';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';

/* --- Manejo de notificaciones --- */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export default function App() {
  useKeepAwake(); // evita que se apague la pantalla si la app está abierta

  /* Permisos cámara (linterna) */
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  /* Ref a cámara “invisible” que usamos solo para el torch */
  const camRef = useRef(null);

  /* Estado de UI / Configuración */
  const [hour, setHour] = useState(5);           // 1..12
  const [minute, setMinute] = useState(0);       // 0..59
  const [ampm, setAmPm] = useState('AM');        // 'AM' | 'PM'
  const [durationMin, setDurationMin] = useState(5); // 1..30
  const [preAlarmNotify, setPreAlarmNotify] = useState(true);
  const [toneUri, setToneUri] = useState(null);  // uri del tono elegido
  const [running, setRunning] = useState(false); // amanecer en curso

  /* Audio */
  const soundRef = useRef(new Audio.Sound());
  const cancelRef = useRef(false);

  /* Cargar ajustes guardados al abrir */
  useEffect(() => {
    (async () => {
      try {
        const s = await AsyncStorage.getItem('ds_settings');
        if (s) {
          const j = JSON.parse(s);
          if (j.hour != null) setHour(j.hour);
          if (j.minute != null) setMinute(j.minute);
          if (j.ampm) setAmPm(j.ampm);
          if (j.durationMin) setDurationMin(j.durationMin);
          if (j.preAlarmNotify != null) setPreAlarmNotify(j.preAlarmNotify);
          if (j.toneUri) setToneUri(j.toneUri);
        }
      } catch {}
    })();
    (async () => {
      try {
        await Notifications.requestPermissionsAsync();
      } catch {}
    })();
  }, []);

  /* Helpers */
  const to24h = (h12, ap) => (ap === 'PM' ? (h12 % 12) + 12 : (h12 % 12));
  function msUntil(h12, m, ap) {
    const h24 = to24h(h12, ap);
    const now = new Date();
    const t = new Date();
    t.setHours(h24, m, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t - now;
  }
  const dec = (v, max, min = 0) => (v - 1 < min ? max : v - 1);
  const inc = (v, max, min = 0) => (v + 1 > max ? min : v + 1);

  /* Guardar ajustes */
  async function saveSettings() {
    await AsyncStorage.setItem(
      'ds_settings',
      JSON.stringify({ hour, minute, ampm, durationMin, preAlarmNotify, toneUri })
    );
    Alert.alert('Guardado', 'Ajustes guardados en el dispositivo.');
  }

  /* Elegir tono desde Archivos */
  async function pickTone() {
    const res = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      copyToCacheDirectory: true,
    });
    if (res.assets && res.assets[0]) {
      setToneUri(res.assets[0].uri);
      Alert.alert('Tono seleccionado', res.assets[0].name || 'audio');
    }
  }

  /* Preparar sonido (volumen 0 e infinito) */
  async function prepareSound() {
    try {
      await soundRef.current.unloadAsync();
    } catch {}
    if (!toneUri) return null;
    await soundRef.current.loadAsync(
      { uri: toneUri },
      { volume: 0.0, isLooping: true, shouldPlay: false }
    );
    return soundRef.current;
  }

  /* Iniciar amanecer (linterna + subir volumen gradualmente) */
  async function startSunrise() {
    // Pedir permiso de cámara si no lo tenemos (para el torch)
    if (!cameraPermission?.granted) {
      const r = await requestCameraPermission();
      if (!r.granted) {
        Alert.alert('Permiso requerido', 'Se necesita acceso a la cámara para encender la linterna.');
        return;
      }
    }

    cancelRef.current = false;
    setRunning(true);
    try {
      const s = await prepareSound();
      if (s) await s.playAsync(); // empieza a volumen 0

      const steps = 20; // pasos de brillo/volumen
      for (let i = 1; i <= steps; i++) {
        if (cancelRef.current) break;
        if (s) await s.setVolumeAsync(i / steps);
        // el torch se controla con enableTorch={running} en el JSX (ver abajo)
        await new Promise((r) => setTimeout(r, (durationMin * 60 * 1000) / steps));
      }

      // Si no cancelamos, dejamos 30s con linterna/sonido al máximo
      if (!cancelRef.current) {
        await new Promise((r) => setTimeout(r, 30 * 1000));
      }
    } catch (e) {
      console.log('Error en amanecer:', e);
    } finally {
      try {
        await soundRef.current.stopAsync();
      } catch {}
      setRunning(false);
    }
  }

  /* Parar amanecer manualmente */
  async function stopSunrise() {
    cancelRef.current = true;
    try {
      await soundRef.current.stopAsync();
    } catch {}
    setRunning(false);
  }

  /* Programar notificación (recordatorio + disparo) */
  async function scheduleAlarm() {
    await saveSettings();
    const ms = msUntil(hour, minute, ampm);

    if (preAlarmNotify && ms > 70000) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Despertador Solar',
          body: 'Empieza en 1 minuto. Abre la app para linterna + tono.',
        },
        trigger: { seconds: Math.floor((ms - 60000) / 1000) },
      });
    }
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Despertador Solar',
        body: '¡Amanecer ahora! Si ves esto, entra a la app.',
      },
      trigger: { seconds: Math.floor(ms / 1000) },
    });

    Alert.alert(
      'Programado',
      `A las ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${ampm}.`
      + '\nDeja la app visible a esa hora para linterna automática (limitación iOS).'
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Despertador Solar (Expo)</Text>

      {/* Hora */}
      <View style={styles.row}>
        <Text style={styles.label}>Hora</Text>
        <View style={styles.timeRow}>
          <Button title="−" onPress={() => setHour(dec(hour, 12, 1))} />
          <Text style={styles.big}>{String(hour).padStart(2, '0')}</Text>
          <Button title="+" onPress={() => setHour(inc(hour, 12, 1))} />
          <Text style={styles.big}>:</Text>
          <Button title="−" onPress={() => setMinute(dec(minute, 59, 0))} />
          <Text style={styles.big}>{String(minute).padStart(2, '0')}</Text>
          <Button title="+" onPress={() => setMinute(inc(minute, 59, 0))} />

          <View style={{ width: 10 }} />

          <TouchableOpacity
            style={[styles.ampm, ampm === 'AM' && styles.ampmActive]}
            onPress={() => setAmPm('AM')}
          >
            <Text style={styles.ampmText}>AM</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.ampm, ampm === 'PM' && styles.ampmActive]}
            onPress={() => setAmPm('PM')}
          >
            <Text style={styles.ampmText}>PM</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Duración */}
      <View style={styles.row}>
        <Text style={styles.label}>Duración amanecer (min): {durationMin}</Text>
        <Slider
          value={durationMin}
          minimumValue={1}
          maximumValue={30}
          step={1}
          onValueChange={(v) =>
            setDurationMin(Math.round(Array.isArray(v) ? v[0] : v))
          }
          style={{ width: 260 }}
        />
      </View>

      {/* Notificación previa */}
      <View style={styles.row}>
        <Text style={styles.label}>Recordatorio 1 min antes</Text>
        <Switch value={preAlarmNotify} onValueChange={setPreAlarmNotify} />
      </View>

      {/* Tono + Guardar */}
      <View style={styles.row}>
        <Button title={toneUri ? 'Cambiar tono' : 'Elegir tono'} onPress={pickTone} />
        <Button title="Guardar" onPress={saveSettings} />
      </View>

      {/* Programar / Probar / Detener */}
      <View style={styles.row}>
        <Button title="Programar" onPress={scheduleAlarm} />
        {!running ? (
          <Button title="Probar ahora" onPress={startSunrise} />
        ) : (
          <Button title="Detener" onPress={stopSunrise} color="#ff5252" />
        )}
      </View>

      {/* Cámara mínima para controlar la linterna (torch). Queda “oculta”. */}
      <View style={{ width: 1, height: 1, overflow: 'hidden' }}>
        <CameraView
          ref={camRef}
          style={{ width: 1, height: 1 }}
          ratio="16:9"
          enableTorch={running} // si running = true, linterna encendida
        />
      </View>

      <Text style={styles.note}>
        iOS no despierta apps con la pantalla bloqueada. Deja la app visible para linterna automática.
        Para audio en segundo plano o pantalla apagada, habría que pasar a app nativa; la linterna
        siempre requiere primer plano por políticas de Apple.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 60, backgroundColor: '#0b0f14' },
  title: { color: '#fff', fontSize: 22, marginBottom: 20, fontWeight: '600' },
  row: { marginVertical: 12, gap: 10 },
  label: { color: '#e8ecf1', marginBottom: 6 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  big: { color: '#fff', fontSize: 22, marginHorizontal: 6 },
  ampm: {
    borderWidth: 1,
    borderColor: '#3a4250',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  ampmActive: { backgroundColor: '#243043', borderColor: '#6ea8fe' },
  ampmText: { color: '#e8ecf1', fontWeight: '600' },
  note: { color: '#9aa4b2', marginTop: 16 },
});
