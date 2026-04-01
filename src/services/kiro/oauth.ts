import { existsSync, readFileSync } from "fs"
import { join } from "path"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import { UpstreamError } from "~/lib/error"

type KiroRefreshResponse = {
    accessToken?: string
    access_token?: string
    refreshToken?: string
    refresh_token?: string
    expiresIn?: number
    expires_in?: number
}

export type CreateKiroAccountInput = {
    refreshToken: string
    email?: string
    label?: string
    authMethod?: string
    clientIdHash?: string
    clientId?: string
    clientSecret?: string
    region?: string
    machineId?: string
    profileArn?: string
}

type KiroLocalTokenFile = {
    accessToken?: string
    refreshToken?: string
    expiresAt?: string
    authMethod?: string
    clientIdHash?: string
    provider?: string
    region?: string
}

type KiroClientRegistrationFile = {
    clientId?: string
    clientSecret?: string
    expiresAt?: string
}

function expandHomePath(value: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    return value.replace(/^~\//, `${homeDir}/`)
}

function getKiroTokenCachePath(): string {
    return expandHomePath("~/.aws/sso/cache/kiro-auth-token.json")
}

function getKiroClientRegistrationPath(clientIdHash: string): string {
    return expandHomePath(`~/.aws/sso/cache/${clientIdHash}.json`)
}

function getKiroMachineIdPath(): string {
    return expandHomePath("~/Library/Application Support/Kiro/machineid")
}

function readKiroMachineId(): string | undefined {
    const path = getKiroMachineIdPath()
    if (!existsSync(path)) return undefined
    try {
        const value = readFileSync(path, "utf-8").trim()
        return value || undefined
    } catch {
        return undefined
    }
}

function readKiroLocalTokenFile(): KiroLocalTokenFile | null {
    const path = getKiroTokenCachePath()
    if (!existsSync(path)) return null
    try {
        return JSON.parse(readFileSync(path, "utf-8")) as KiroLocalTokenFile
    } catch (error) {
        consola.warn("Kiro local auth import failed:", error)
        return null
    }
}

function readKiroClientRegistrationFile(clientIdHash?: string): KiroClientRegistrationFile | null {
    const hash = clientIdHash?.trim()
    if (!hash) return null
    const path = getKiroClientRegistrationPath(hash)
    if (!existsSync(path)) return null
    try {
        return JSON.parse(readFileSync(path, "utf-8")) as KiroClientRegistrationFile
    } catch (error) {
        consola.warn("Kiro client registration import failed:", error)
        return null
    }
}

function toTimestamp(expiresAt?: string): number | undefined {
    if (!expiresAt) return undefined
    const timestamp = Date.parse(expiresAt)
    return Number.isFinite(timestamp) ? timestamp : undefined
}

function getKiroRegion(region?: string): string {
    return (region || "us-east-1").trim() || "us-east-1"
}

function getKiroRefreshUrl(region?: string): string {
    return `https://prod.${getKiroRegion(region)}.auth.desktop.kiro.dev/refreshToken`
}

function getKiroOidcTokenUrl(region?: string): string {
    return `https://oidc.${getKiroRegion(region)}.amazonaws.com/token`
}

type KiroRefreshInput = {
    refreshToken: string
    region?: string
    authMethod?: string
    clientIdHash?: string
    clientId?: string
    clientSecret?: string
}

type KiroRefreshResult = {
    accessToken: string
    refreshToken?: string
    expiresIn: number
}

function resolveKiroClientCredentials(input: KiroRefreshInput): { clientId?: string; clientSecret?: string; clientIdHash?: string } {
    const directClientId = input.clientId?.trim()
    const directClientSecret = input.clientSecret?.trim()
    if (directClientId && directClientSecret) {
        return {
            clientId: directClientId,
            clientSecret: directClientSecret,
            clientIdHash: input.clientIdHash?.trim(),
        }
    }

    const registration = readKiroClientRegistrationFile(input.clientIdHash)
    return {
        clientId: directClientId || registration?.clientId?.trim() || undefined,
        clientSecret: directClientSecret || registration?.clientSecret?.trim() || undefined,
        clientIdHash: input.clientIdHash?.trim(),
    }
}

async function refreshKiroIdCAccessToken(input: KiroRefreshInput): Promise<KiroRefreshResult> {
    const { clientId, clientSecret } = resolveKiroClientCredentials(input)
    if (!clientId || !clientSecret) {
        throw new Error("Kiro IdC refresh requires clientId and clientSecret")
    }

    const response = await fetch(getKiroOidcTokenUrl(input.region), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
            clientId,
            clientSecret,
            refreshToken: input.refreshToken,
            grantType: "refresh_token",
        }),
    })
    const text = await response.text()
    let data: KiroRefreshResponse | null = null
    try {
        data = text ? JSON.parse(text) as KiroRefreshResponse : null
    } catch {
        data = null
    }

    if (!response.ok) {
        throw new UpstreamError("kiro", response.status, text, response.headers.get("retry-after") || undefined)
    }

    const accessToken = data?.accessToken || data?.access_token
    const expiresIn = data?.expiresIn || data?.expires_in || 3600
    if (!accessToken) {
        throw new Error("Kiro IdC token refresh succeeded but no accessToken was returned")
    }

    return {
        accessToken,
        refreshToken: data?.refreshToken || data?.refresh_token || input.refreshToken,
        expiresIn,
    }
}

async function refreshKiroDesktopAccessToken(input: KiroRefreshInput): Promise<KiroRefreshResult> {
    const response = await fetch(getKiroRefreshUrl(input.region), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: input.refreshToken }),
    })
    const text = await response.text()
    let data: KiroRefreshResponse | null = null
    try {
        data = text ? JSON.parse(text) as KiroRefreshResponse : null
    } catch {
        data = null
    }

    if (!response.ok) {
        throw new UpstreamError("kiro", response.status, text, response.headers.get("retry-after") || undefined)
    }

    const accessToken = data?.accessToken || data?.access_token
    const expiresIn = data?.expiresIn || data?.expires_in || 3600
    if (!accessToken) {
        throw new Error("Kiro token refresh succeeded but no accessToken was returned")
    }

    return {
        accessToken,
        refreshToken: data?.refreshToken || data?.refresh_token || input.refreshToken,
        expiresIn,
    }
}

export async function refreshKiroAccessToken(input: KiroRefreshInput): Promise<KiroRefreshResult> {
    if (input.authMethod === "IdC") {
        return refreshKiroIdCAccessToken(input)
    }
    return refreshKiroDesktopAccessToken(input)
}

export async function refreshKiroAccountIfNeeded(account: ProviderAccount): Promise<ProviderAccount> {
    const hasFreshToken = account.accessToken && account.expiresAt && account.expiresAt > Date.now() + 60_000
    if (hasFreshToken || !account.refreshToken) {
        return account
    }

    const refreshed = await refreshKiroAccessToken({
        refreshToken: account.refreshToken,
        region: account.region,
        authMethod: account.authMethod,
        clientIdHash: account.clientIdHash,
        clientId: account.clientId,
        clientSecret: account.clientSecret,
    })
    const updated: ProviderAccount = {
        ...account,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || account.refreshToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
        region: getKiroRegion(account.region),
    }
    authStore.saveAccount(updated)
    return updated
}

export async function createKiroManualAccount(input: CreateKiroAccountInput): Promise<ProviderAccount> {
    const region = getKiroRegion(input.region)
    const refreshed = await refreshKiroAccessToken({
        refreshToken: input.refreshToken,
        region,
        authMethod: input.authMethod,
        clientIdHash: input.clientIdHash,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
    })
    const now = new Date().toISOString()
    const account: ProviderAccount = {
        id: input.email?.trim() || input.label?.trim() || `kiro-${Date.now()}`,
        provider: "kiro",
        email: input.email?.trim() || undefined,
        label: input.label?.trim() || input.email?.trim() || "Kiro",
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || input.refreshToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
        authMethod: input.authMethod,
        clientIdHash: input.clientIdHash?.trim() || undefined,
        clientId: input.clientId?.trim() || undefined,
        clientSecret: input.clientSecret?.trim() || undefined,
        region,
        machineId: input.machineId?.trim() || undefined,
        profileArn: input.profileArn?.trim() || undefined,
        authSource: "kiro-manual",
        createdAt: now,
        updatedAt: now,
    }
    authStore.saveAccount(account)
    return account
}

export async function importKiroAuthSources(): Promise<{ accounts: ProviderAccount[]; sources: string[] }> {
    const local = readKiroLocalTokenFile()
    if (!local?.accessToken || !local.refreshToken) {
        return { accounts: [], sources: [] }
    }
    const clientRegistration = readKiroClientRegistrationFile(local.clientIdHash)

    const account: ProviderAccount = {
        id: `kiro-${getKiroRegion(local.region)}`,
        provider: "kiro",
        label: "Kiro Local",
        accessToken: local.accessToken,
        refreshToken: local.refreshToken,
        expiresAt: toTimestamp(local.expiresAt),
        authMethod: local.authMethod,
        clientIdHash: local.clientIdHash,
        clientId: clientRegistration?.clientId?.trim() || undefined,
        clientSecret: clientRegistration?.clientSecret?.trim() || undefined,
        region: getKiroRegion(local.region),
        machineId: readKiroMachineId(),
        authSource: "kiro-local",
    }

    authStore.saveAccount(account)
    const sources = [join("~", ".aws", "sso", "cache", "kiro-auth-token.json")]
    if (local.clientIdHash && clientRegistration) {
        sources.push(join("~", ".aws", "sso", "cache", `${local.clientIdHash}.json`))
    }
    return {
        accounts: [account],
        sources,
    }
}
