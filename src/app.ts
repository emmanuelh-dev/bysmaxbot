import express from 'express'
import { readFile } from 'node:fs/promises'
import {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeWASocket,
    useMultiFileAuthState,
    type WAMessage,
} from '@whiskeysockets/baileys'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { botConfig } from './config'

const PORT = process.env.PORT ?? 3008
const DOC_URL = 'https://bysmax.com'
const MODEL_CANDIDATES = [botConfig.model, 'gemini-2.0-flash', 'gemini-1.5-flash']
const HANDOFF_TRIGGER_PHRASES = [
    'quiero hablar con una persona',
    'quiero hablar con alguien',
    'pasame con una persona',
    'pasame con alguien',
    'asesor humano',
    'agente humano',
    'hablar con soporte',
    'hablar con un humano',
]
const HANDOFF_RESUME_PHRASES = [
    'ya puedes responder',
    'reactivar bot',
    'activar bot',
    'reanudar bot',
    'termino soporte humano',
]

type GeminiHistoryItem = { role: 'user' | 'model'; parts: { text: string }[] }

/**
 * Configuración de Gemini
 */
const genAI = new GoogleGenerativeAI(botConfig.apiKey)
const hasValidGeminiKey = Boolean(botConfig.apiKey) && !botConfig.apiKey.includes('TU_API_KEY_AQUI')

const timers = new Map<string, NodeJS.Timeout>()
const buffers = new Map<string, string[]>()
const histories = new Map<string, GeminiHistoryItem[]>()
const blacklist = new Set<string>()
const lidPhoneCache = new Map<string, string | null>()
const humanHandoffUsers = new Set<string>()

const app = express()
let socketRef: ReturnType<typeof makeWASocket> | null = null

app.use(express.json({ limit: '2mb' }))

app.post('/v1/messages', async (req, res) => {
    try {
        const { number, message, urlMedia } = req.body ?? {}
        if (!number || !message) {
            return res.status(400).json({ status: 'error', message: 'number y message son requeridos' })
        }

        const jid = toJid(String(number))
        await sendText(jid, String(message))

        if (urlMedia) {
            await sendText(jid, `Media: ${String(urlMedia)}`)
        }

        return res.json({ status: 'ok' })
    } catch (error) {
        console.error('Error en /v1/messages:', error)
        return res.status(500).json({ status: 'error' })
    }
})

app.post('/v1/blacklist', (req, res) => {
    const { number, intent } = req.body ?? {}
    if (!number || !intent) {
        return res.status(400).json({ status: 'error', message: 'number e intent son requeridos' })
    }

    const cleanNumber = normalizeNumber(String(number))
    if (intent === 'add') {
        blacklist.add(cleanNumber)
    }
    if (intent === 'remove') {
        blacklist.delete(cleanNumber)
    }

    return res.json({ status: 'ok', number: cleanNumber, intent })
})

app.get('/v1/blacklist/list', (_req, res) => {
    return res.json({ status: 'ok', blacklist: Array.from(blacklist) })
})

app.post('/v1/handoff', async (req, res) => {
    const { number, intent } = req.body ?? {}
    if (!number || !intent) {
        return res.status(400).json({ status: 'error', message: 'number e intent son requeridos' })
    }

    const jid = toJid(String(number))
    if (intent === 'on') {
        activateHumanHandoff(jid)
        await sendText(jid, botConfig.humanHandoffMessage)
        return res.json({ status: 'ok', number: normalizeNumber(jid), intent: 'on' })
    }

    if (intent === 'off') {
        deactivateHumanHandoff(jid)
        await sendText(jid, botConfig.botResumedMessage)
        return res.json({ status: 'ok', number: normalizeNumber(jid), intent: 'off' })
    }

    return res.status(400).json({ status: 'error', message: 'intent debe ser on u off' })
})

async function startServer() {
    if (!hasValidGeminiKey) {
        console.warn('GEMINI_API_KEY/GOOGLE_API_KEY no está configurada. El bot iniciará, pero no podrá responder con IA hasta que la configures.')
    }
    await connectWhatsApp()

    app.listen(Number(PORT), () => {
        console.log(`Server running on port ${PORT}`)
    })
}

async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('bot_sessions')
    const { version } = await fetchLatestBaileysVersion()

    const socket = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: true,
    })

    socketRef = socket

    socket.ev.on('creds.update', saveCreds)
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'open') {
            console.log('WhatsApp conectado')
            return
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
            const isSessionReplaced = statusCode === 440
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !isSessionReplaced
            console.log('WhatsApp desconectado', { statusCode, shouldReconnect })

            if (shouldReconnect) {
                await connectWhatsApp()
                return
            }

            if (isSessionReplaced) {
                console.warn('La sesión de WhatsApp fue reemplazada por otro cliente. Cierra otras instancias y vuelve a iniciar este bot.')
            }
        }
    })

    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0]
        await onIncomingMessage(message)
    })
}

async function onIncomingMessage(message: WAMessage) {
    const remoteJid = message.key.remoteJid
    if (!remoteJid || message.key.fromMe) {
        return
    }

    if (!isDirectChatJid(remoteJid)) {
        return
    }

    const userId = await resolveReplyJid(remoteJid)
    if (!userId) {
        console.warn('No se pudo resolver el JID de respuesta para mensaje entrante', { remoteJid })
        return
    }

    const text = getMessageText(message)
    if (!text) {
        return
    }

    const userNumber = normalizeNumber(userId)
    if (blacklist.has(userNumber)) {
        return
    }

    if (shouldActivateHumanHandoff(text)) {
        activateHumanHandoff(userId)
        await sendText(userId, botConfig.humanHandoffMessage)
        return
    }

    if (shouldResumeBot(text)) {
        deactivateHumanHandoff(userId)
        await sendText(userId, botConfig.botResumedMessage)
        return
    }

    if (isHumanHandoffActive(userId)) {
        return
    }

    if (!buffers.has(userId)) {
        buffers.set(userId, [])
    }

    buffers.get(userId)?.push(text)

    const currentTimer = timers.get(userId)
    if (currentTimer) {
        clearTimeout(currentTimer)
    }

    const timer = setTimeout(async () => {
        try {
            const userMessages = buffers.get(userId) ?? []
            buffers.delete(userId)
            timers.delete(userId)

            if (userMessages.length === 0) {
                return
            }

            const fullPrompt = userMessages.join('\n')
            const finalResponse = await getFinalResponse(userId, fullPrompt)
            await sendText(userId, finalResponse)
            appendHistory(userId, fullPrompt, finalResponse)
        } catch (error) {
            buffers.delete(userId)
            timers.delete(userId)
            console.error('Error procesando mensaje:', error)
            if (isRateLimitedError(error)) {
                await sendText(userId, 'Estoy recibiendo muchas solicitudes en este momento. Intenta de nuevo en un minuto, por favor.')
                return
            }

            await sendText(userId, 'Lo siento, tuve un problema procesando tus mensajes.')
        }
    }, botConfig.idleTime)

    timers.set(userId, timer)
}

async function getFinalResponse(userId: string, prompt: string) {
    if (isSampleRequest(prompt)) {
        return buildSamplesResponse()
    }

    if (isPriceRequest(prompt)) {
        return `El precio del menu digital con pedidos por WhatsApp es de $${botConfig.menuPrice} MXN al mes.\n\nSi quieres, te explico rapido como quedaria en tu negocio y en cuanto tiempo lo dejamos listo.`
    }

    const aiResponse = await getAIResponse(userId, prompt)
    return resolveIntentResponse(aiResponse)
}

async function getAIResponse(userId: string, prompt: string) {
    if (!hasValidGeminiKey) {
        return 'Necesito que configures GEMINI_API_KEY (o GOOGLE_API_KEY) para poder responder con IA.'
    }

    const history: GeminiHistoryItem[] = histories.get(userId) ?? []
    const uniqueModels = Array.from(new Set(MODEL_CANDIDATES.filter(Boolean)))

    let response = ''
    let lastError: unknown = null

    for (const modelName of uniqueModels) {
        try {
            const model = genAI.getGenerativeModel({
                model: modelName,
                systemInstruction: botConfig.systemInstruction,
            })
            const chat = model.startChat({ history })
            const result = await chat.sendMessage(prompt)
            response = result.response.text().trim()
            break
        } catch (error) {
            lastError = error
            if (isModelNotFoundError(error)) {
                console.warn('Modelo Gemini no disponible, probando fallback', { modelName })
                continue
            }
            throw error
        }
    }

    if (!response) {
        throw lastError ?? new Error('No fue posible obtener respuesta de Gemini con los modelos configurados')
    }

    return response
}

function appendHistory(userId: string, userText: string, modelText: string) {
    const history: GeminiHistoryItem[] = histories.get(userId) ?? []
    const newHistory: GeminiHistoryItem[] = [
        ...history,
        { role: 'user' as const, parts: [{ text: userText }] },
        { role: 'model' as const, parts: [{ text: modelText }] },
    ].slice(-(botConfig.maxHistoryTurns * 2))

    histories.set(userId, newHistory)
}

function isModelNotFoundError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false
    }

    const typedError = error as { status?: number; message?: string }
    if (typedError.status === 404) {
        return true
    }

    const message = String(typedError.message ?? '').toLowerCase()
    return message.includes('is not found') || message.includes('not supported for generatecontent')
}

function isRateLimitedError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false
    }

    const typedError = error as { status?: number; message?: string }
    if (typedError.status === 429) {
        return true
    }

    const message = String(typedError.message ?? '').toLowerCase()
    return message.includes('too many requests') || message.includes('resource exhausted')
}

function shouldActivateHumanHandoff(text: string) {
    const normalized = normalizeText(text)
    return HANDOFF_TRIGGER_PHRASES.some((phrase) => normalized.includes(phrase))
}

function shouldResumeBot(text: string) {
    const normalized = normalizeText(text)
    return HANDOFF_RESUME_PHRASES.some((phrase) => normalized.includes(phrase))
}

function isHumanHandoffActive(userId: string) {
    return humanHandoffUsers.has(userId)
}

function activateHumanHandoff(userId: string) {
    humanHandoffUsers.add(userId)
    clearUserBuffer(userId)
}

function deactivateHumanHandoff(userId: string) {
    humanHandoffUsers.delete(userId)
    clearUserBuffer(userId)
}

function clearUserBuffer(userId: string) {
    const currentTimer = timers.get(userId)
    if (currentTimer) {
        clearTimeout(currentTimer)
    }

    timers.delete(userId)
    buffers.delete(userId)
}

function normalizeText(text: string) {
    return text
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
}

function isSampleRequest(text: string) {
    const normalized = normalizeText(text)
    const triggers = ['ejemplo', 'ejemplos', 'demo', 'demos', 'muestra', 'mostrar', 'muestrame', 'samples']
    return triggers.some((item) => normalized.includes(item))
}

function isPriceRequest(text: string) {
    const normalized = normalizeText(text)
    const triggers = ['precio', 'precios', 'cuanto cuesta', 'costo', 'costos', 'cuanto sale', 'valor']
    return triggers.some((item) => normalized.includes(item))
}

function resolveIntentResponse(response: string) {
    if (response === 'ACCION_DOC') {
        return `Puedes ver la documentación aquí:\n${DOC_URL}`
    }

    if (response === 'ACCION_SAMPLES') {
        return buildSamplesResponse()
    }

    if (response === 'ACCION_REGISTRO') {
        return 'Perfecto. Para registrarte, comparteme tu nombre completo y correo.'
    }

    if (response.includes('$[precio]')) {
        return `El precio del menu digital con pedidos por WhatsApp es de $${botConfig.menuPrice} MXN al mes.\n\nSi quieres, te explico rapido como quedaria en tu negocio y en cuanto tiempo lo dejamos listo.`
    }

    return response
}

function buildSamplesResponse() {
    const links = botConfig.menuSampleLinks.map((link, index) => `${index + 1}. ${link}`).join('\n')
    return `Claro, aqui tienes ejemplos reales:\n\n${links}\n\nSi quieres, te muestro cual te conviene mas para cafeteria.`
}

async function sendText(userId: string, text: string) {
    if (!socketRef) {
        throw new Error('WhatsApp no está conectado todavía')
    }

    await socketRef.sendMessage(userId, { text })
}

function getMessageText(message: WAMessage) {
    const content = message.message
    if (!content) {
        return ''
    }

    if (content.conversation) {
        return content.conversation.trim()
    }

    if (content.extendedTextMessage?.text) {
        return content.extendedTextMessage.text.trim()
    }

    if (content.imageMessage?.caption) {
        return content.imageMessage.caption.trim()
    }

    if (content.videoMessage?.caption) {
        return content.videoMessage.caption.trim()
    }

    return ''
}

function normalizeNumber(userId: string) {
    const digits = userId.split('@')[0] ?? userId
    return digits.replace(/\D/g, '').slice(-10)
}

function toJid(number: string) {
    const clean = number.replace(/\D/g, '')
    return `${clean}@s.whatsapp.net`
}

function isDirectChatJid(jid: string) {
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')
}

async function resolveReplyJid(remoteJid: string) {
    if (remoteJid.endsWith('@s.whatsapp.net')) {
        return remoteJid
    }

    if (!remoteJid.endsWith('@lid')) {
        return null
    }

    const lid = remoteJid.split('@')[0]?.split(':')[0]
    if (!lid) {
        return null
    }

    const mappedNumber = await mapLidToPhone(lid)
    if (!mappedNumber) {
        return null
    }

    return toJid(mappedNumber)
}

async function mapLidToPhone(lid: string) {
    if (lidPhoneCache.has(lid)) {
        return lidPhoneCache.get(lid) ?? null
    }

    try {
        const raw = await readFile(`bot_sessions/lid-mapping-${lid}_reverse.json`, 'utf8')
        const number = String(JSON.parse(raw) ?? '').replace(/\D/g, '')
        const value = number || null
        lidPhoneCache.set(lid, value)
        return value
    } catch {
        lidPhoneCache.set(lid, null)
        return null
    }
}

startServer().catch((error) => {
    console.error('No se pudo iniciar el servidor:', error)
    process.exit(1)
})
