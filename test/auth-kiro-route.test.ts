import { beforeEach, expect, mock, test } from "bun:test"

beforeEach(() => {
    mock.restore()
})

test("POST /auth/login imports local kiro account when refresh token is omitted", async () => {
    mock.module("~/services/antigravity/login", () => ({
        isAuthenticated: () => false,
        getUserInfo: () => ({ email: undefined, name: undefined }),
        setAuth: () => { },
        clearAuth: () => { },
        startOAuthLogin: async () => ({ success: false }),
    }))
    mock.module("~/services/antigravity/account-manager", () => ({
        accountManager: { load: () => { }, addAccount: () => { } },
    }))
    mock.module("~/lib/state", () => ({
        state: {},
    }))
    mock.module("~/services/auth/store", () => ({
        authStore: {
            listSummaries: () => [],
        },
    }))
    mock.module("~/services/codex/oauth", () => ({
        debugCodexOAuth: () => undefined,
        importCodexAuthSources: async () => ({ accounts: [], sources: [] }),
        startCodexCliLogin: async () => undefined,
        getCodexCliLoginStatus: async () => ({ status: "pending" }),
    }))
    mock.module("~/services/copilot/oauth", () => ({
        startCopilotDeviceFlow: async () => ({}),
        pollCopilotSession: async () => ({ status: "pending" }),
        importCopilotAuthFiles: () => [],
    }))
    mock.module("~/services/antigravity/ide-switch", () => ({
        getIdeAuthStatus: async () => ({ authenticated: false }),
        logoutIdeSession: async () => ({ success: true }),
    }))
    mock.module("~/services/zed/oauth", () => ({
        importZedLocalAccount: async () => ({
            id: "zed-local",
            login: "zed",
            label: "Zed",
            authSource: "zed-local",
        }),
    }))
    mock.module("~/services/kiro/oauth", () => ({
        createKiroManualAccount: async () => {
            throw new Error("manual flow should not be used")
        },
        importKiroAuthSources: async () => ({
            accounts: [{
                id: "kiro-us-east-1",
                email: undefined,
                label: "Kiro Local",
                region: "us-east-1",
            }],
            sources: ["~/.aws/sso/cache/kiro-auth-token.json"],
        }),
    }))

    const { authRouter } = await import(`../src/routes/auth/route.ts?${Date.now()}-kiro-route`)
    const response = await authRouter.request("http://localhost/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "kiro" }),
    })
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toMatchObject({
        success: true,
        provider: "kiro",
        status: "success",
        source: "import",
        account: {
            id: "kiro-us-east-1",
            label: "Kiro Local",
            region: "us-east-1",
        },
    })
})
