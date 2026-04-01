export interface EvolutionWebhookPayload {
    instance: string
    sender: string
    message: string
}

export function mapEvolutionSenderToUserId(sender: string): string {
    const cleanNumber = sender.replace(/\D/g, '')
    return `${cleanNumber}@s.whatsapp.net`
}
