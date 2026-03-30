import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, utils } from '@builderbot/bot'
import { JsonFileDB as Database } from '@builderbot/database-json'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { botConfig } from './config'

const PORT = process.env.PORT ?? 3008

/**
 * Configuración de Gemini
 */
const genAI = new GoogleGenerativeAI(botConfig.apiKey)
const model = genAI.getGenerativeModel({ 
    model: botConfig.model,
    systemInstruction: botConfig.systemInstruction 
})

// Mapa para gestionar el debounce por usuario
const timers = new Map<string, NodeJS.Timeout>()
// Mapa para acumular mensajes por usuario
const buffers = new Map<string, string[]>()

const aiFlow = addKeyword<Provider, Database>(utils.setEvent('WELCOME_AI'))
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from
        
        // Inicializar buffer si no existe
        if (!buffers.has(userId)) buffers.set(userId, [])
        buffers.get(userId).push(ctx.body)

        // Limpiar timer existente si el usuario sigue escribiendo
        if (timers.has(userId)) {
            clearTimeout(timers.get(userId))
        }

        // Configurar nuevo timer de 5 segundos
        const timer = setTimeout(async () => {
            try {
                const userMessages = buffers.get(userId) || []
                buffers.delete(userId)
                timers.delete(userId)

                const fullPrompt = userMessages.join('\n')
                
                // Obtener historial del estado si existe
                const history = state.get<{ role: string, parts: { text: string }[] }[]>('history') || []
                
                const chat = model.startChat({
                    history: history,
                })

                const result = await chat.sendMessage(fullPrompt)
                const response = result.response.text()

                // Actualizar historial (limitado a los últimos 10 mensajes para no saturar tokens)
                const newHistory = [
                    ...history,
                    { role: 'user', parts: [{ text: fullPrompt }] },
                    { role: 'model', parts: [{ text: response }] }
                ].slice(-10)
                
                await state.update({ history: newHistory })

                // Enviar respuesta
                await flowDynamic(response)

            } catch (err) {
                console.error('Error con Gemini:', err)
                await flowDynamic('Lo siento, tuve un problema procesando tus mensajes.')
            }
        }, botConfig.idleTime)

        timers.set(userId, timer)
    })

const discordFlow = addKeyword<Provider, Database>('doc').addAnswer(
    ['You can see the documentation here', '📄 https://builderbot.app/docs \n', 'Do you want to continue? *yes*'].join(
        '\n'
    ),
    { capture: true },
    async (ctx, { gotoFlow, flowDynamic }) => {
        if (ctx.body.toLocaleLowerCase().includes('yes')) {
            return gotoFlow(registerFlow)
        }
        await flowDynamic('Thanks!')
        return
    }
)

const welcomeFlow = addKeyword<Provider, Database>(['hi', 'hello', 'hola'])
    .addAnswer(`🙌 Hola bienvenido a *BYSMAX*`)
    .addAnswer(
        [
            'Soy tu asistente virtual. ¿En qué puedo ayudarte hoy?',
            '👉 Escribe *doc* para ver la documentación técnica',
            '👉 O simplemente hazme una pregunta sobre nuestros servicios.',
        ].join('\n'),
        { delay: 800, capture: true },
        async (ctx, { fallBack, gotoFlow }) => {
            if (ctx.body.toLocaleLowerCase().includes('doc')) {
                return
            }
            // Si no es un comando de doc, pasamos al flujo de IA
            return gotoFlow(aiFlow)
        },
        [discordFlow, aiFlow]
    )

const registerFlow = addKeyword<Provider, Database>(utils.setEvent('REGISTER_FLOW'))
    .addAnswer(`What is your name?`, { capture: true }, async (ctx, { state }) => {
        await state.update({ name: ctx.body })
    })
    .addAnswer('What is your age?', { capture: true }, async (ctx, { state }) => {
        await state.update({ age: ctx.body })
    })
    .addAction(async (_, { flowDynamic, state }) => {
        await flowDynamic(`${state.get('name')}, thanks for your information!: Your age: ${state.get('age')}`)
    })

const fullSamplesFlow = addKeyword<Provider, Database>(['samples', utils.setEvent('SAMPLES')])
    .addAnswer(`💪 I'll send you a lot files...`)
    .addAnswer(`Send image from Local`, { media: join(process.cwd(), 'assets', 'sample.png') })
    .addAnswer(`Send video from URL`, {
        media: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExYTJ0ZGdjd2syeXAwMjQ4aWdkcW04OWlqcXI3Ynh1ODkwZ25zZWZ1dCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/LCohAb657pSdHv0Q5h/giphy.mp4',
    })
    .addAnswer(`Send audio from URL`, { media: 'https://cdn.freesound.org/previews/728/728142_11861866-lq.mp3' })
    .addAnswer(`Send file from URL`, {
        media: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    })

const main = async () => {
    const adapterFlow = createFlow([welcomeFlow, registerFlow, fullSamplesFlow, aiFlow])
    
    // If you experience ERRO AUTH issues, check the latest WhatsApp version at:
    // https://wppconnect.io/whatsapp-versions/
    // Example: version "2.3000.1035824857-alpha" -> [2, 3000, 1035824857]
    const adapterProvider = createProvider(Provider, 
		{ version: [2, 3000, 1035824857] } 
	)
    
    const adapterDB = new Database({ filename: 'db.json' })

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    adapterProvider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    adapterProvider.server.get(
        '/v1/blacklist/list',
        handleCtx(async (bot, req, res) => {
            const blacklist = bot.blacklist.getList()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', blacklist }))
        })
    )

    httpServer(+PORT)
}

main()
