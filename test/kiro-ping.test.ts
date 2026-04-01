import { afterAll, expect, mock, test } from "bun:test"
import type { ProviderAccount } from "~/services/auth/types"

const kiroAccount: ProviderAccount = {
    id: "kiro-1",
    provider: "kiro",
    accessToken: "access-token",
    refreshToken: "refresh-token",
}

async function importPingWithMocks() {
    mock.module("~/services/auth/store", () => ({
        authStore: {
            getAccount: () => kiroAccount,
        },
    }))

    mock.module("~/services/antigravity/chat", () => ({
        createChatCompletionWithOptions: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    }))

    mock.module("~/services/antigravity/account-manager", () => ({
        accountManager: {
            getAccountById: async () => null,
        },
    }))

    mock.module("~/services/antigravity/quota-fetch", () => ({
        fetchAntigravityModels: async () => ({ models: {} }),
    }))

    mock.module("~/services/codex/chat", () => ({
        createCodexCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    }))

    mock.module("~/services/copilot/chat", () => ({
        createCopilotCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    }))

    mock.module("~/services/zed/chat", () => ({
        createZedCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    }))

    mock.module("~/services/kiro/chat", () => ({
        createKiroCompletion: async () => ({ contentBlocks: [{ type: "text", text: "pong" }], stopReason: "end_turn", usage: {} }),
    }))

    mock.module("~/services/routing/config", () => ({
        loadRoutingConfig: () => ({ version: 2, updatedAt: new Date().toISOString(), flows: [], accountRouting: { smartSwitch: false, routes: [] } }),
    }))

    return import(`../src/services/ping.ts?${Date.now()}-${Math.random()}`)
}

test("pingAccount can probe a kiro account using static kiro models", async () => {
    const { pingAccount } = await importPingWithMocks()
    const result = await pingAccount("kiro", "kiro-1")

    expect(result.modelId).toBe("claude-opus-4-6")
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    mock.restore()
})

afterAll(() => {
    mock.restore()
})
