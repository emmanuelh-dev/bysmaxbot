# Configuración del Entorno - WhatsApp Bot (BYSMAX)

Sigue estos comandos para configurar tu entorno de desarrollo en macOS/Linux.

### 1. Instalar Node.js (v22)
Utilizando `nvm` (recomendado):
```bash
nvm install 22 && nvm use 22
```

### 2. Instalar Bun
```bash
curl -fsSL https://bun.sh/install | bash
```
_(Reinicia tu terminal después de instalar Bun)_

### 3. Instalar Dependencias del Proyecto
```bash
bun install
```

### 4. Configurar Variables de Entorno
Crea un archivo `.env` en la raíz del proyecto:
```bash
touch .env
```
Edita el archivo `.env` y agrega tu llave de Gemini:
```env
PORT=3008
GEMINI_API_KEY=tu_api_key_aqui
```

### 5. Iniciar el Bot (Modo Desarrollo)
```bash
bun start
```

---
**Nota:** Para obtener tu `GEMINI_API_KEY`, visita [Google AI Studio](https://aistudio.google.com/).
