# Lector TTS

Lector de libros `.txt` en voz alta, pensado para escuchar libros largos con comodidad. Todo funciona en tu dispositivo: no hay cuentas, nubes ni sincronización.

## Qué hace

- **Biblioteca de inicio:** guarda los libros que abres para entrar rápido después, con progreso, tiempo restante y una tarjeta de "Continuar escuchando".
- **Ordenar la biblioteca:** por recientes, fecha de carga, nombre o longitud (con flecha para invertir), o en tu propio orden arrastrando cada libro desde su manija.
- **Varios archivos a la vez:** eliges uno o varios `.txt`; se guardan todos y el primero se abre directo en el lector. En la computadora también puedes arrastrarlos a la ventana.
- **Lector en vivo:** resalta la oración que se está leyendo, y la palabra si lo activas. La vista sigue la lectura sola; si te desplazas a mano, aparece un botón para volver.
- **Toca una frase** para leer desde ahí.
- **Dos tipos de voz:**
  - *Del dispositivo:* las voces que trae el sistema (Google, Microsoft, Apple). Las que suelen sonar más naturales salen primero, marcadas con ★.
  - *Neuronal:* voces Piper que corren localmente. Se descargan una sola vez (28–77 MB) y después funcionan sin internet. Hay voces en español de México y España, y algunas en inglés.
- **Comodidad:** velocidad, tono, pausa entre párrafos, tamaño de letra, interlineado, fuente serif o sans, y temas claro, sepia, oscuro o automático.
- **Temporizador para dormir:** con la voz neuronal baja el volumen poco a poco antes de pausar.
- **Recuerda dónde te quedaste** en cada libro.
- **Funciona sin conexión** y se instala como app (PWA).
- **Segundo plano:** sigue leyendo con otras apps abiertas o la pantalla bloqueada, con un reproductor en las notificaciones (pausa, frase anterior/siguiente y barra de progreso del libro). Se pausa sola si entra una llamada u otra app pone audio. Funciona mejor con la voz neuronal; con la voz del dispositivo depende de Android.
- **Se actualiza sola:** cuando hay una versión nueva, la app se recarga en cuanto no está leyendo, en el mismo libro y frase.
- **Archivos .txt** en UTF-8, UTF-16 o Windows-1252 (los `.txt` viejos en español). Las líneas cortadas a mano se unen en párrafos.

## Desarrollo

```bash
npm install
npm run dev
```

Para generar la versión final en `dist/`:

```bash
npm run build
```

`npm run dev` y `npm run build` copian a `public/vendor/` los archivos WebAssembly de la voz neuronal (ONNX Runtime y el fonetizador de Piper), así la app no depende de CDNs externos. Los modelos de voz se descargan de Hugging Face cuando el usuario elige una voz y quedan guardados en el navegador (OPFS).

## Estructura

- `src/text.js`: lectura del `.txt`, detección de codificación, párrafos y oraciones.
- `src/db.js`: biblioteca en IndexedDB.
- `src/player.js`: bucle de lectura, posición, pausa y temporizador.
- `src/keepalive.js`: audio casi inaudible que mantiene la página activa en segundo plano y el reproductor en las notificaciones.
- `src/tts/system.js`: voces del dispositivo (Web Speech API).
- `src/tts/neural.js` y `src/tts/neural.worker.js`: voz neuronal Piper en un Web Worker.
- `src/library.js`, `src/reader.js`, `src/settings-ui.js`: pantallas.
- `public/sw.js`: soporte sin conexión (la compilación le inyecta la lista de archivos y la versión).
- `.github/workflows/deploy.yml`: publica en GitHub Pages con cada cambio en `main`.
