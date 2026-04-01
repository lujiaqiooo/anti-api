import { expect, mock, test } from "bun:test"

test("fetchKiroQuotaSnapshot reads CodeWhisperer usage limits and email", async () => {
    mock.restore()

    let savedAccount: Record<string, unknown> | null = null
    mock.module("~/services/auth/store", () => ({
        authStore: {
            saveAccount: (account: Record<string, unknown>) => {
                savedAccount = account
            },
        },
    }))
    mock.module("~/services/kiro/oauth", () => ({
        refreshKiroAccountIfNeeded: async (account: Record<string, unknown>) => account,
    }))

    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        if (url === "https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles") {
            return new Response(JSON.stringify({
                profiles: [{
                    arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
                    profileName: "KiroProfile-us-east-1",
                }],
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })
        }
        if (url === "https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true&profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A123456789012%3Aprofile%2Ftest") {
            return new Response(JSON.stringify({
                nextDateReset: "2026-05-01T00:00:00.000Z",
                subscriptionInfo: {
                    subscriptionTitle: "KIRO PRO",
                    type: "Q_DEVELOPER_STANDALONE_PRO",
                },
                usageBreakdownList: [{
                    resourceType: "CREDIT",
                    displayName: "Credit",
                    currentUsageWithPrecision: 0.19,
                    usageLimitWithPrecision: 1000,
                    nextDateReset: 1777593600,
                }],
                userInfo: {
                    email: "alice@example.com",
                },
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })
        }
        throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    try {
        const { fetchKiroQuotaSnapshot } = await import(`../src/services/kiro/chat.ts?${Date.now()}-quota`)
        const snapshot = await fetchKiroQuotaSnapshot({
            id: "kiro-us-east-1",
            provider: "kiro",
            label: "Kiro Local",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            region: "us-east-1",
        })

        expect(calls).toEqual([
            "https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles",
            "https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true&profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A123456789012%3Aprofile%2Ftest",
        ])
        expect(snapshot).toMatchObject({
            displayName: "alice@example.com",
            subscriptionTitle: "KIRO PRO",
            bar: {
                key: "credit",
                label: "credit",
                percentage: 100,
                resetTime: "2026-05-01T00:00:00.000Z",
                valueText: "0.19/1,000",
            },
        })
        expect(savedAccount).toMatchObject({
            id: "kiro-us-east-1",
            label: "KiroProfile-us-east-1",
            email: "alice@example.com",
            profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
            subscriptionType: "Q_DEVELOPER_STANDALONE_PRO",
            subscriptionTitle: "KIRO PRO",
        })
    } finally {
        globalThis.fetch = originalFetch
        mock.restore()
    }
})
