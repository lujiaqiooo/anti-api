import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

function withTempHome(): { dir: string; prevHome: string | undefined; prevProfile: string | undefined } {
    const dir = mkdtempSync(join(tmpdir(), "anti-api-test-"))
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    return { dir, prevHome, prevProfile }
}

function restoreEnv(prevHome: string | undefined, prevProfile: string | undefined) {
    if (prevHome === undefined) {
        delete process.env.HOME
    } else {
        process.env.HOME = prevHome
    }
    if (prevProfile === undefined) {
        delete process.env.USERPROFILE
    } else {
        process.env.USERPROFILE = prevProfile
    }
}

test("authStore saves and lists accounts", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { authStore } = await import(`../src/services/auth/store.ts?${Date.now()}`)

    authStore.saveAccount({
        id: "acc-1",
        provider: "antigravity",
        email: "user@example.com",
        accessToken: "token",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
    })

    const accounts = authStore.listAccounts("antigravity")
    expect(accounts.length).toBe(1)
    expect(accounts[0].email).toBe("user@example.com")

    const summaries = authStore.listSummaries("antigravity")
    expect(summaries[0].displayName).toBe("user@example.com")

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})

test("authStore rate limit toggles state", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { authStore } = await import(`../src/services/auth/store.ts?${Date.now()}`)

    const delay = authStore.markRateLimited("antigravity", "acc-2", 429, "quota exhausted", "5")
    expect(delay).toBeGreaterThan(0)
    expect(authStore.isRateLimited("antigravity", "acc-2")).toBe(true)

    authStore.markSuccess("antigravity", "acc-2")
    expect(authStore.isRateLimited("antigravity", "acc-2")).toBe(false)

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})

test("authStore persists kiro-specific fields", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { authStore } = await import(`../src/services/auth/store.ts?${Date.now()}-save`)

    authStore.saveAccount({
        id: "kiro-1",
        provider: "kiro",
        email: "kiro@example.com",
        label: "Kiro Primary",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
        authMethod: "IdC",
        clientIdHash: "client-hash",
        clientId: "client-id",
        clientSecret: "client-secret",
        region: "us-east-1",
        machineId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        profileArn: "arn:aws:iam::123456789012:role/Kiro",
        subscriptionType: "pro",
    })

    const { authStore: reloadedStore } = await import(`../src/services/auth/store.ts?${Date.now()}-reload`)
    const account = reloadedStore.getAccount("kiro", "kiro-1")

    expect(account).not.toBeNull()
    expect(account?.authMethod).toBe("IdC")
    expect(account?.clientIdHash).toBe("client-hash")
    expect(account?.clientId).toBe("client-id")
    expect(account?.clientSecret).toBe("client-secret")
    expect(account?.region).toBe("us-east-1")
    expect(account?.machineId).toBe("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
    expect(account?.profileArn).toBe("arn:aws:iam::123456789012:role/Kiro")
    expect(account?.subscriptionType).toBe("pro")

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})
