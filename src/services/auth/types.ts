export type AuthProvider = "antigravity" | "codex" | "copilot" | "zed" | "kiro"
export type AuthSource = "codex-cli" | "cli-proxy" | "zed-local" | "kiro-manual" | "kiro-local"

export interface ProviderAccount {
    id: string
    provider: AuthProvider
    email?: string
    login?: string
    label?: string
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    projectId?: string
    organizationId?: string
    serverUrl?: string
    authMethod?: string
    clientIdHash?: string
    clientId?: string
    clientSecret?: string
    region?: string
    machineId?: string
    profileArn?: string
    subscriptionType?: string
    subscriptionTitle?: string
    authSource?: AuthSource
    createdAt?: string
    updatedAt?: string
}

export interface ProviderAccountSummary {
    id: string
    provider: AuthProvider
    displayName: string
    email?: string
    login?: string
    label?: string
    expiresAt?: number
}
