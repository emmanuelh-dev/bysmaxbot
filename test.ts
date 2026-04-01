const blacklist = new Set(["521234567890", "+11234567891"].map(normalizeNumber))
console.log(blacklist)
function normalizeNumber(userId: string) {
    const digits = userId.split('@')[0] ?? userId
    return digits.replace(/\D/g, '').slice(-10)
}
