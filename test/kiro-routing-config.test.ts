import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { ProviderAccount } from "~/services/auth/types"

type Provider = "antigravity" | "codex" | "copilot" | "zed" | "kiro"

const accountsByProvider: Record<Provider, ProviderAccount[]> = {
    antigravity: [],
    codex: [],
    copilot: [],
    zed: [],
    kiro: [],
}

let tempHome: string | null = null
let prevHome: string | undefined
let prevProfile: string | undefined
const debugCalls: string[] = []

function setupRoutingMocks(): void {
    mock.module("consola", () => ({
        default: {
            debug: (...args: unknown[]) => {
                debugCalls.push(args.map(arg => String(arg)).join(" "))
            },
            warn: () => {},
            success: () => {},
            error: () => {},
            info: () => {},
        },
    }))

    mock.module("~/services/auth/store", () => ({
        authStore: {
            listAccounts: (provider?: Provider) => {
                if (!provider) {
                    return Object.values(accountsByProvider).flat()
                }
                return [...accountsByProvider[provider]]
            },
            listSummaries: (provider?: Provider) => {
                const accounts = provider ? accountsByProvider[provider] : Object.values(accountsByProvider).flat()
                return accounts.map(account => ({
                    id: account.id,
                    provider: account.provider,
                    displayName: account.label || account.email || account.login || account.id,
                    email: account.email,
                    login: account.login,
                    label: account.label,
                    expiresAt: account.expiresAt,
                }))
            },
            getAccount: (provider: Provider, id: string) => {
                return accountsByProvider[provider].find(account => account.id === id) || null
            },
        },
    }))

    mock.module("~/services/antigravity/account-manager", () => ({
        accountManager: {
            load: () => {},
            clearAllRateLimits: () => {},
            hasAccount: () => true,
        },
    }))

    mock.module("~/services/quota-aggregator", () => ({
        getAggregatedQuota: async () => null,
    }))

    mock.module("~/services/copilot/chat", () => ({
        createCopilotCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
        listCopilotModelsForAccount: async () => [],
    }))

    mock.module("~/services/codex/chat", () => ({
        createCodexCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
        listCodexModelsForAccount: async () => [],
        isCodexModelSupportedForAccount: () => undefined,
        isCodexUnsupportedModelError: () => false,
    }))

    mock.module("~/services/zed/chat", () => ({
        createZedCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
        listZedModelsForAccount: async () => [],
    }))

    mock.module("~/services/antigravity/quota-fetch", () => ({
        fetchAntigravityModels: async () => ({ models: {} }),
    }))

    mock.module("~/services/kiro/chat", () => ({
        listKiroModelsForAccount: () => [
            { id: "claude-opus-4-6", label: "Kiro - Claude Opus 4.6" },
            { id: "claude-sonnet-4-6", label: "Kiro - Claude Sonnet 4.6" },
        ],
    }))
}

async function getRoutingRouter() {
    setupRoutingMocks()
    const mod = await import(`../src/routes/routing/route.ts?${Date.now()}-${Math.random()}`)
    return mod.routingRouter
}

beforeEach(() => {
    prevHome = process.env.HOME
    prevProfile = process.env.USERPROFILE
    tempHome = mkdtempSync(join(tmpdir(), "anti-api-kiro-routing-"))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    mkdirSync(join(tempHome, ".anti-api"), { recursive: true })

    accountsByProvider.antigravity = []
    accountsByProvider.codex = []
    accountsByProvider.copilot = []
    accountsByProvider.zed = []
    accountsByProvider.kiro = [{
        id: "kiro-1",
        provider: "kiro",
        accessToken: "kiro-token",
        refreshToken: "kiro-refresh",
        email: "kiro@example.com",
        label: "Kiro Main",
        createdAt: "2026-04-01T00:00:00.000Z",
    }]
    debugCalls.length = 0
})

afterEach(() => {
    if (tempHome) {
        rmSync(tempHome, { recursive: true, force: true })
    }
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
    tempHome = null
    mock.restore()
})

afterAll(() => {
    mock.restore()
})

test("routing config includes kiro accounts and static kiro models", async () => {
    const routingRouter = await getRoutingRouter()
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.accounts.kiro).toHaveLength(1)
    expect(data.accounts.kiro[0]).toMatchObject({
        id: "kiro-1",
        provider: "kiro",
        displayName: "Kiro Main",
    })
    expect(data.models.kiro.some((model: { id: string }) => model.id === "claude-opus-4-6-thinking")).toBe(true)
    expect(data.accountModels.kiro["kiro-1"].some((model: { id: string }) => model.id === "claude-haiku-4-5")).toBe(true)
})

test("routing config logs kiro model sync", async () => {
    const routingRouter = await getRoutingRouter()
    const res = await routingRouter.request("/config")

    expect(res.status).toBe(200)
    expect(debugCalls.some(line => line.includes("[routing] Kiro models synced (2) from kiro-1"))).toBe(true)
})
