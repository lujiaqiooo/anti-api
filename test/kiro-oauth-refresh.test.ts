import { expect, mock, test } from "bun:test"

test("refreshKiroAccountIfNeeded uses AWS OIDC CreateToken for IdC accounts", async () => {
    mock.restore()

    let savedAccount: Record<string, unknown> | null = null
    mock.module("~/services/auth/store", () => ({
        authStore: {
            saveAccount: (account: Record<string, unknown>) => {
                savedAccount = account
            },
        },
    }))

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://oidc.us-east-1.amazonaws.com/token")
        expect(init?.method).toBe("POST")
        expect(init?.headers).toEqual({
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
        expect(JSON.parse(String(init?.body))).toEqual({
            clientId: "kiro-client-id",
            clientSecret: "kiro-client-secret",
            refreshToken: "kiro-refresh-token",
            grantType: "refresh_token",
        })
        return new Response(JSON.stringify({
            accessToken: "new-access-token",
            refreshToken: "new-refresh-token",
            expiresIn: 3600,
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })
    }) as typeof fetch

    try {
        const { refreshKiroAccountIfNeeded } = await import(`../src/services/kiro/oauth.ts?${Date.now()}-refresh`)
        const updated = await refreshKiroAccountIfNeeded({
            id: "kiro-us-east-1",
            provider: "kiro",
            accessToken: "expired-access-token",
            refreshToken: "kiro-refresh-token",
            expiresAt: 0,
            authMethod: "IdC",
            clientIdHash: "client-hash",
            clientId: "kiro-client-id",
            clientSecret: "kiro-client-secret",
            region: "us-east-1",
        })

        expect(updated.accessToken).toBe("new-access-token")
        expect(updated.refreshToken).toBe("new-refresh-token")
        expect(updated.authMethod).toBe("IdC")
        expect(savedAccount).toMatchObject({
            id: "kiro-us-east-1",
            accessToken: "new-access-token",
            refreshToken: "new-refresh-token",
            authMethod: "IdC",
            clientIdHash: "client-hash",
        })
    } finally {
        globalThis.fetch = originalFetch
        mock.restore()
    }
})
