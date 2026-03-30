# Configuración del Entorno - WhatsApp Bot (BYSMAX)

Sigue estos comandos para configurar tu entorno de desarrollo en **Ubuntu** (o macOS).

### 1. Instalar NVM (Node Version Manager)
Ejecuta el script oficial de instalación:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```
Luego, activa NVM sin reiniciar la terminal:
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

### 2. Instalar Node.js (v22)
```bash
nvm install 22 && nvm use 22
```

### 3. Instalar Bun
```bash
curl -fsSL https://bun.sh/install | bash
```
Activa Bun en la sesión actual:
```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

### 4. Instalar Dependencias del Proyecto
```bash
bun install
```

### 5. Configurar Variables de Entorno
Crea un archivo `.env` en la raíz del proyecto:
```bash
touch .env
```
Edita el archivo `.env` y agrega tu llave de Gemini:
```env
PORT=3008
GEMINI_API_KEY=tu_api_key_aqui
```

### 6. Iniciar el Bot (Modo Desarrollo)
```bash
bun start
```

---
**Nota:** Para obtener tu `GEMINI_API_KEY`, visita [Google AI Studio](https://aistudio.google.com/).
